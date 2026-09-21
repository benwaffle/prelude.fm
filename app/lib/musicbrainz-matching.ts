/**
 * Deciding which MusicBrainz release an album is.
 *
 * Kept apart from the database so the rules can be read, tested and argued
 * with on their own. Every one of them exists to refuse rather than to
 * accept: a wrong release attaches every track on the album to the wrong
 * recording, and nothing downstream can see that it happened, because the
 * titles and the works all look plausible.
 */
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

/**
 * How far a duration may differ and still be the same performance.
 *
 * Five seconds when identifying a release, where the question is whether an
 * unknown tracklist lines up and a wrong answer is expensive.
 *
 * Fifteen when anchoring tracks to a release already identified. The evidence
 * there is the whole tracklist agreeing, not any one track, and a CD master
 * and its Spotify transfer routinely differ by several seconds of lead-in and
 * fade — one album measured here ran from three to ten seconds out on five of
 * its twelve tracks, all of them plainly the same performances. A per-track
 * cut at three seconds rejected them and left the album ragged, anchoring
 * seven tracks and abandoning five that sat between the two it kept.
 */
const RELEASE_TOLERANCE_MS = 5_000;
export const POSITION_TOLERANCE_MS = 15_000;

/**
 * A release whose durations MusicBrainz mostly does not record cannot be
 * confirmed by duration, and title plus track count alone is not enough — two
 * editions of the same album share both.
 */
const MIN_TIMED_FRACTION = 0.8;

/** At most this many candidates are fetched before a search is called ambiguous. */
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

/* ------------------------------------------------- which release is it --- */

/**
 * Does this MusicBrainz release plausibly hold the same recordings, in the
 * same order, as the Spotify album?
 *
 * Track count must be exact and every comparable duration must agree. The
 * fraction rule is what stops a release with no durations at all from passing
 * on title and count, which two editions of the same album would also do.
 */
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

/**
 * Find the MusicBrainz release for an album.
 *
 * Barcode first: it is the release's own identifier and an exact match needs
 * no corroboration. Several releases sharing a barcode is usually one record
 * issued in several territories, which for our purposes — recordings and
 * ISRCs — are interchangeable, so they are only ambiguous when their recording
 * sets actually differ.
 *
 * Failing that, title and track count narrow the field and durations decide,
 * which reaches the releases MusicBrainz holds without a barcode.
 */
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
    // Two releases that both fit are two editions of the same record, and
    // choosing between them here would be a coin toss.
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

/* ------------------------------------------------------ track alignment --- */

export type PositionedTrack = { discNumber: number; trackNumber: number; durationMs: number };
export type PositionedReleaseTrack = { medium: number; position: number; length: number | null };

/**
 * Does the album's tracklist line up with the release's, position for
 * position?
 *
 * Asked once per album rather than once per track, because that is the shape
 * of the evidence. Either this release has the same tracks in the same order —
 * in which case every position is trustworthy — or it does not, in which case
 * none of them is. Answering per track produces an album anchored in patches,
 * which is the worst of both: the gaps look like missing data rather than like
 * the doubt about the whole tracklist that they really are.
 */
export function tracklistAligns(
  tracks: PositionedTrack[],
  releaseTracks: PositionedReleaseTrack[],
  toleranceMs = POSITION_TOLERANCE_MS,
): boolean {
  if (tracks.length === 0) return false;

  /*
   * A Spotify album is one edition; a MusicBrainz release can be several
   * mediums of the same content. A hybrid SACD is three — a CD layer and two
   * SACD layers — so an eighteen-track album meets a fifty-four-track
   * release and nothing lines up, even though the album is exactly medium
   * one. Where the whole release does not match, a single medium that does
   * is tried instead.
   */
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

  return alignsByPosition(tracks, releaseTracks, toleranceMs);
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

/**
 * The tolerance for a track we hold in isolation.
 *
 * Three seconds, not fifteen. When the whole tracklist lines up, one track
 * being seconds out is explained by the rest; a single track out of a
 * hundred-track box set has nothing standing behind it but its own duration,
 * so it has to carry the weight on its own.
 */
export const LONE_TRACK_TOLERANCE_MS = 3_000;

/**
 * Does this one track sit at this position on the release?
 *
 * Used where the album is a fragment of the release rather than the whole of
 * it — a liked track from a box set, which is most of what a personal library
 * is made of. There is no tracklist to corroborate the position, so the
 * duration has to agree closely and an untimed release track is not enough.
 */
export function loneTrackFits(
  track: PositionedTrack,
  releaseTrack: PositionedReleaseTrack | undefined,
  toleranceMs = LONE_TRACK_TOLERANCE_MS,
): boolean {
  if (!releaseTrack) return false;
  if (releaseTrack.length == null) return false;
  return Math.abs(releaseTrack.length - track.durationMs) <= toleranceMs;
}
