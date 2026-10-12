// Kept apart from the DB so the rules can be tested. Every rule exists to refuse: a wrong release
// silently attaches every track to the wrong recording.
import type { MbRelease, MusicBrainzSource } from './musicbrainz-source';

export type AlbumIdentity = {
  spotifyId: string;
  title: string;
  upc: string | null;
  mbReleaseId: string | null;
};

export type AlbumTrack = {
  spotifyId: string;
  title: string;
  discNumber: number;
  trackNumber: number;
  durationMs: number;
  isrc: string | null;
};

// 5s when identifying a release. 15s when anchoring to an identified one: the whole tracklist is
// the evidence, and CD masters and Spotify transfers routinely differ by several seconds of lead-in
// and fade.
const RELEASE_TOLERANCE_MS = 5_000;
export const POSITION_TOLERANCE_MS = 15_000;

/** Title plus track count alone is not enough: two editions of the same album share both. */
const MIN_TIMED_FRACTION = 0.8;

const MAX_CANDIDATES = 4;

export type ReleaseMatch = {
  releaseMbid: string;
  matchedBy: 'known' | 'barcode' | 'title_duration';
  requests: number;
};

export type ReleaseMatchFailure = {
  releaseMbid: null;
  reason: 'no_barcode_match' | 'ambiguous' | 'not_found';
  candidates: string[];
  requests: number;
};

const normaliseBarcode = (value: string | null | undefined) =>
  (value ?? '').trim().replace(/^0+/, '');

/** The fraction rule stops a release with no durations from passing on title and count alone. */
export function releaseFitsAlbum(
  tracks: AlbumTrack[],
  release: MbRelease,
  toleranceMs = RELEASE_TOLERANCE_MS,
): boolean {
  if (release.tracks.length !== tracks.length) return false;

  const ordered = [...tracks].sort(
    (a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber,
  );
  const mbOrdered = [...release.tracks].sort(
    (a, b) => a.medium - b.medium || a.position - b.position,
  );

  let timed = 0;
  for (let i = 0; i < ordered.length; i++) {
    const length = mbOrdered[i].length ?? mbOrdered[i].recording.length;
    if (length == null) continue;
    timed++;
    if (Math.abs(length - ordered[i].durationMs) > toleranceMs) return false;
  }

  return timed >= Math.ceil(ordered.length * MIN_TIMED_FRACTION);
}

// Barcode first. Releases sharing a barcode are usually territories with the same recordings, so
// only ambiguous when their recording sets differ. Then title and track count narrow, and durations
// decide.
export async function findReleaseForAlbum(
  source: MusicBrainzSource,
  album: AlbumIdentity,
  tracks: AlbumTrack[],
): Promise<ReleaseMatch | ReleaseMatchFailure> {
  if (album.mbReleaseId) {
    return { releaseMbid: album.mbReleaseId, matchedBy: 'known', requests: 0 };
  }

  let requests = 0;

  const barcode = normaliseBarcode(album.upc);
  if (barcode) {
    const candidates = await source.releasesByBarcode(barcode);
    requests++;

    if (candidates.length === 1) {
      return { releaseMbid: candidates[0], matchedBy: 'barcode', requests };
    }

    if (candidates.length > 1 && candidates.length <= MAX_CANDIDATES) {
      const sets: string[][] = [];
      for (const candidate of candidates) {
        sets.push(await source.releaseRecordingIds(candidate));
        requests++;
      }
      const first = sets[0].join('|');
      const interchangeable = sets.every((set) => set.join('|') === first);
      if (interchangeable && sets[0].length > 0) {
        return { releaseMbid: candidates[0], matchedBy: 'barcode', requests };
      }
      return { releaseMbid: null, reason: 'ambiguous', candidates, requests };
    }

    if (candidates.length > MAX_CANDIDATES) {
      return { releaseMbid: null, reason: 'ambiguous', candidates, requests };
    }
  }

  const shortlist = await source.searchReleases(album.title, tracks.length);
  requests++;

  const fits: string[] = [];
  for (const candidate of shortlist.slice(0, MAX_CANDIDATES)) {
    const release = await source.releaseWithRecordings(candidate);
    requests++;
    if (release && releaseFitsAlbum(tracks, release)) fits.push(candidate);
    // Two releases that both fit are two editions; choosing between them would be a coin toss.
    if (fits.length > 1) break;
  }

  if (fits.length === 1) {
    return { releaseMbid: fits[0], matchedBy: 'title_duration', requests };
  }
  if (fits.length > 1) {
    return { releaseMbid: null, reason: 'ambiguous', candidates: fits, requests };
  }
  return {
    releaseMbid: null,
    reason: barcode ? 'no_barcode_match' : 'not_found',
    candidates: [],
    requests,
  };
}

export type PositionedTrack = { discNumber: number; trackNumber: number; durationMs: number };
export type PositionedReleaseTrack = { medium: number; position: number; length: number | null };

// Asked per album, not per track: either every position is trustworthy or none is; per-track
// answers anchor in patches.
export function tracklistAligns(
  tracks: PositionedTrack[],
  releaseTracks: PositionedReleaseTrack[],
  toleranceMs = POSITION_TOLERANCE_MS,
): boolean {
  if (tracks.length === 0) return false;

  // A hybrid SACD release repeats the album on three mediums, so try a single matching medium.
  if (tracks.length !== releaseTracks.length) {
    const mediums = new Set(releaseTracks.map((track) => track.medium));
    if (mediums.size < 2) return false;
    return [...mediums].some((medium) => {
      const onlyThis = releaseTracks.filter((track) => track.medium === medium);
      if (onlyThis.length !== tracks.length) return false;
      // Compare on position alone: the album's disc numbering is its own.
      return alignsByPosition(
        tracks.map((track, index) => ({ ...track, discNumber: 1, trackNumber: index + 1 })),
        onlyThis.map((track, index) => ({ ...track, medium: 1, position: index + 1 })),
        toleranceMs,
      );
    });
  }

  if (alignsByPosition(tracks, releaseTracks, toleranceMs)) return true;

  // Spotify flattens multi-disc releases into one run (9 + 12 becomes 21), so compare in order;
  // durations still have to agree, so a reordered tracklist fails this too.
  return alignsInOrder(tracks, releaseTracks, toleranceMs);
}

function alignsInOrder(
  tracks: PositionedTrack[],
  releaseTracks: PositionedReleaseTrack[],
  toleranceMs: number,
): boolean {
  const ours = [...tracks].sort(
    (a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber,
  );
  const theirs = [...releaseTracks].sort((a, b) => a.medium - b.medium || a.position - b.position);

  for (let i = 0; i < ours.length; i++) {
    const length = theirs[i]?.length;
    if (length == null) continue;
    if (Math.abs(length - ours[i].durationMs) > toleranceMs) return false;
  }
  return true;
}

function alignsByPosition(
  tracks: PositionedTrack[],
  releaseTracks: PositionedReleaseTrack[],
  toleranceMs: number,
): boolean {
  const byPosition = new Map(
    releaseTracks.map((track) => [`${track.medium}:${track.position}`, track]),
  );

  for (const track of tracks) {
    const counterpart = byPosition.get(`${track.discNumber}:${track.trackNumber}`);
    if (!counterpart) return false;
    if (counterpart.length == null) continue;
    if (Math.abs(counterpart.length - track.durationMs) > toleranceMs) return false;
  }

  return true;
}

/** Three seconds, not fifteen: a lone track has no tracklist standing behind it. */
export const LONE_TRACK_TOLERANCE_MS = 3_000;

// For a liked track from a box set: no tracklist corroborates the position, so an untimed release
// track is not enough.
export function loneTrackFits(
  track: PositionedTrack,
  releaseTrack: PositionedReleaseTrack | undefined,
  toleranceMs = LONE_TRACK_TOLERANCE_MS,
): boolean {
  if (!releaseTrack) return false;
  if (releaseTrack.length == null) return false;
  return Math.abs(releaseTrack.length - track.durationMs) <= toleranceMs;
}

export type TracklistDiagnosis =
  /** Same recordings, different order. Somebody's tracklist is wrong. */
  | { kind: 'reordered'; matched: number }
  /** The release has a different number of tracks, and no single medium fits. */
  | { kind: 'different-length'; ours: number; theirs: number }
  /** Same length, but the durations do not correspond in any order. */
  | { kind: 'different-recordings'; matched: number }
  | { kind: 'aligned' };

// Reordering is detected by pairing durations as a set; one release here lists its tracks rotated
// by one.
export function diagnoseTracklist(
  tracks: PositionedTrack[],
  releaseTracks: PositionedReleaseTrack[],
  toleranceMs = POSITION_TOLERANCE_MS,
): TracklistDiagnosis {
  if (tracklistAligns(tracks, releaseTracks, toleranceMs)) return { kind: 'aligned' };

  if (tracks.length !== releaseTracks.length) {
    return { kind: 'different-length', ours: tracks.length, theirs: releaseTracks.length };
  }

  const unused = releaseTracks.filter((track) => track.length != null);
  const taken = new Set<number>();
  let matched = 0;
  for (const track of tracks) {
    const index = unused.findIndex(
      (candidate, i) =>
        !taken.has(i) && Math.abs(candidate.length! - track.durationMs) <= toleranceMs,
    );
    if (index !== -1) {
      taken.add(index);
      matched++;
    }
  }

  // Nearly all pairing off means the same recordings reordered; only some means different
  // performances.
  return matched >= Math.ceil(tracks.length * 0.8)
    ? { kind: 'reordered', matched }
    : { kind: 'different-recordings', matched };
}
