/**
 * What the person adding a release changed, compared with Harmony's seed.
 *
 * The seed is the Spotify album (`release-seed.ts`): its titles, its
 * credits, and — because Harmony cannot know better — a new recording for
 * every track in a new release group. What landed on MusicBrainz is compared
 * with that, one kind of change at a time, so that across albums we can see
 * which kinds of album land untouched and which always need the same fix.
 *
 * A change here is a difference between seed and result. It is usually the
 * person's correction, but Harmony can merge other stores' data into the
 * seed, and a difference from that is indistinguishable here.
 *
 * Everything is pure. Where a comparison could not be made — a recording
 * whose history we could not read, a seed with no album artist — it is
 * listed in `incomplete` rather than counted as unchanged.
 */
import {
  looseName,
  orderedSeedTracks,
  type ReleaseSeed,
  type SeedArtist,
  type SeedTrack,
} from './release-seed';

export type LandedArtist = { mbid: string; name: string };

export type LandedTrack = {
  medium: number;
  position: number;
  title: string;
  lengthMs: number | null;
  artists: LandedArtist[];
  recording: { mbid: string; title: string; artists: LandedArtist[]; isrcs: string[] };
};

export type LandedRelease = {
  mbid: string;
  title: string;
  artists: LandedArtist[];
  releaseGroup: {
    mbid: string;
    title: string;
    /** Other releases in the group; null when that could not be read. */
    otherReleases: number | null;
  };
  media: number;
  tracks: LandedTrack[];
};

/**
 * `reused`: the recording is on another release too, or existed before (the
 * pre-check found it by ISRC). `created`: on this release only. `unknown`:
 * its releases could not be read.
 */
export type RecordingOrigin = 'reused' | 'created' | 'unknown';

export type AlbumKind = 'new-edition' | 'box-set' | 'compilation' | 'single-composer' | 'unknown';

export const ALBUM_KIND_LABELS: Record<AlbumKind, string> = {
  'new-edition': 'New edition of an existing album',
  'box-set': 'Box set or several discs',
  compilation: 'Several composers',
  'single-composer': 'One composer',
  unknown: "Couldn't tell",
};

export type CorrectionType =
  | 'release-title'
  | 'release-artist'
  | 'release-group-reused'
  | 'seeded-recordings-replaced'
  | 'track-titles'
  | 'track-title-punctuation'
  | 'track-artists'
  | 'recordings-reused'
  | 'recording-titles'
  | 'recording-artists'
  | 'tracks-added'
  | 'tracks-removed'
  | 'tracks-moved';

/** Plain words for each kind of change, as the admin page shows them. */
export const CORRECTION_LABELS: Record<CorrectionType, string> = {
  'release-title': 'Album title changed',
  'release-artist': 'Album artist changed',
  'release-group-reused': 'Joined an existing album group',
  'seeded-recordings-replaced': 'Pre-filled recordings replaced',
  'track-titles': 'Track titles reworded',
  'track-title-punctuation': 'Track titles: punctuation only',
  'track-artists': 'Track artists changed',
  'recordings-reused': 'Existing recordings reused',
  'recording-titles': 'New recordings retitled',
  'recording-artists': 'New recordings’ artists changed',
  'tracks-added': 'Tracks added',
  'tracks-removed': 'Tracks removed',
  'tracks-moved': 'Tracks reordered',
};

export type ReleaseCorrectionRecord = {
  version: 1;
  releaseMbid: string;
  releaseTitle: string;
  releaseGroupMbid: string;
  /** Where the seed came from: the stored pre-check, a live Spotify read, or our copy. */
  /**
   * `prelude-seed`: the form we seeded (our credits and pre-filled
   * recordings). The others are the Spotify album Harmony would read.
   */
  baselineSource: 'precheck' | 'spotify' | 'library' | 'prelude-seed';
  kind: AlbumKind;
  kindWhy: string;
  tracks: {
    seeded: number;
    landed: number;
    paired: number;
    added: number;
    removed: number;
    moved: number;
    pairedBy: { isrc: number; position: number; duration: number };
  };
  albumTitle: { changed: boolean; from: string; to: string };
  releaseArtist: { changed: boolean; from: string[]; to: string[] } | null;
  titles: { changed: number; punctuationOnly: number; examples: { from: string; to: string }[] };
  trackArtists: { changed: number; examples: { title: string; from: string[]; to: string[] }[] };
  recordings: {
    reused: number;
    created: number;
    unknown: number;
    /** Reused recordings the baseline did not already name (a person picked them). */
    reusedUnseeded?: number;
    /** Tracks whose pre-filled recording landed as seeded. */
    seededKept?: number;
    /** Tracks whose pre-filled recording was swapped for another. */
    seededReplaced?: number;
    /** Of the created recordings: title differs from the Spotify track title. */
    titleChanged: number;
    /** Of the created recordings: artists differ from the Spotify track artists. */
    artistsChanged: number;
    examples: { from: string; to: string }[];
  };
  releaseGroup: 'reused' | 'new' | 'unknown';
  corrections: CorrectionType[];
  incomplete: string[];
};

const EXAMPLES = 5;

/* ------------------------------------------------------------ comparisons */

/** Punctuation and spacing that a typographic cleanup changes. Case is kept. */
export function punctuationKey(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\p{Pd}/gu, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compareTitle(from: string, to: string): 'same' | 'punctuation' | 'changed' {
  if (from === to) return 'same';
  return punctuationKey(from) === punctuationKey(to) ? 'punctuation' : 'changed';
}

/**
 * Whether a landed credit names the same artists as a seeded one, in any
 * order. A seeded artist whose MusicBrainz identity is known (the pre-check
 * found it linked to its Spotify page) matches by MBID, so a credit printed
 * as "Vivaldi" for Antonio Vivaldi is not a change; anyone else matches by
 * name.
 */
export function sameCredit(
  seeded: SeedArtist[],
  landed: LandedArtist[],
  mbidOf: (artist: SeedArtist) => string | null = () => null,
): boolean {
  const remaining = [...landed];
  for (const artist of seeded) {
    const mbid = artist.mbid ?? mbidOf(artist);
    const index = remaining.findIndex(
      (candidate) =>
        (mbid !== null && candidate.mbid === mbid) ||
        looseName(candidate.name) === looseName(artist.name),
    );
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

/* ---------------------------------------------------------------- pairing */

export type TrackPair = {
  seed: SeedTrack;
  landed: LandedTrack;
  by: 'recording' | 'isrc' | 'position' | 'duration';
};

const POSITION_TOLERANCE_MS = 5_000;
const DURATION_TOLERANCE_MS = 2_000;

/**
 * Which landed track each seeded track became.
 *
 * By ISRC first (only reused recordings carry one), then by the same disc and
 * position with a length that agrees, then by a unique near-identical length
 * anywhere. What is left over on either side was removed or added.
 */
export function pairTracks(
  seed: ReleaseSeed,
  landed: LandedTrack[],
): { pairs: TrackPair[]; removed: SeedTrack[]; added: LandedTrack[] } {
  const seedTracks = orderedSeedTracks(seed);
  const landedTracks = [...landed].sort((a, b) => a.medium - b.medium || a.position - b.position);
  const freeSeed = new Set(seedTracks);
  const freeLanded = new Set(landedTracks);
  const pairs: TrackPair[] = [];
  const take = (s: SeedTrack, l: LandedTrack, by: TrackPair['by']) => {
    pairs.push({ seed: s, landed: l, by });
    freeSeed.delete(s);
    freeLanded.delete(l);
  };

  // A recording we pre-filled is the surest pairing there is.
  for (const s of seedTracks) {
    if (!s.recordingMbid) continue;
    const match = [...freeLanded].find((l) => l.recording.mbid === s.recordingMbid);
    if (match) take(s, match, 'recording');
  }
  for (const s of [...freeSeed]) {
    if (!s.isrc) continue;
    const isrc = s.isrc.toUpperCase();
    const match = [...freeLanded].find((l) =>
      l.recording.isrcs.some((candidate) => candidate.toUpperCase() === isrc),
    );
    if (match) take(s, match, 'isrc');
  }
  for (const s of [...freeSeed]) {
    const match = [...freeLanded].find(
      (l) =>
        l.medium === s.disc &&
        l.position === s.position &&
        (l.lengthMs === null || Math.abs(l.lengthMs - s.durationMs) <= POSITION_TOLERANCE_MS),
    );
    if (match) take(s, match, 'position');
  }
  for (const s of [...freeSeed]) {
    const near = [...freeLanded].filter(
      (l) => l.lengthMs !== null && Math.abs(l.lengthMs - s.durationMs) <= DURATION_TOLERANCE_MS,
    );
    if (near.length === 1) take(s, near[0], 'duration');
  }

  const order = new Map(seedTracks.map((track, index) => [track, index]));
  pairs.sort((a, b) => order.get(a.seed)! - order.get(b.seed)!);
  return { pairs, removed: [...freeSeed], added: [...freeLanded] };
}

/**
 * How many paired tracks are out of order. Tracks added or removed shift
 * positions without reordering anything, so this counts the tracks outside
 * the longest run that kept its relative order.
 */
export function movedCount(pairs: TrackPair[]): number {
  const landedIndex = (track: LandedTrack) => track.medium * 10_000 + track.position;
  const sequence = pairs.map((pair) => landedIndex(pair.landed));
  const tails: number[] = [];
  for (const value of sequence) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tails[mid] < value) low = mid + 1;
      else high = mid;
    }
    tails[low] = value;
  }
  return sequence.length - tails.length;
}

/* ------------------------------------------------------------------- kind */

/**
 * One coarse label, in order of what most changes how the release is added:
 * joining an existing group, then several discs, then how many composers.
 * `composers` is null when no composer could be identified.
 */
export function albumKind(input: {
  releaseGroup: ReleaseCorrectionRecord['releaseGroup'];
  media: number;
  composers: number | null;
}): { kind: AlbumKind; why: string } {
  if (input.releaseGroup === 'reused') {
    return { kind: 'new-edition', why: 'the release joined a group that already had releases' };
  }
  if (input.media > 1) return { kind: 'box-set', why: `${input.media} discs` };
  if (input.composers !== null && input.composers >= 2) {
    return { kind: 'compilation', why: `${input.composers} composers identified` };
  }
  if (input.composers === 1) return { kind: 'single-composer', why: 'one composer identified' };
  return { kind: 'unknown', why: 'no composer could be identified' };
}

/* ---------------------------------------------------------------- compare */

export function compareRelease(input: {
  seed: ReleaseSeed;
  baselineSource: ReleaseCorrectionRecord['baselineSource'];
  landed: LandedRelease;
  origins: Map<string, RecordingOrigin>;
  composers: number | null;
  /** MusicBrainz artist for a Spotify artist id, where the pre-check found one linked. */
  artistMbids?: Map<string, string>;
  /** The release group we seeded, when the baseline is our own seed. */
  seededReleaseGroup?: string | null;
}): ReleaseCorrectionRecord {
  const { seed, landed, origins } = input;
  const mbidOf = (artist: SeedArtist) =>
    artist.spotifyId ? (input.artistMbids?.get(artist.spotifyId) ?? null) : null;
  const { pairs, removed, added } = pairTracks(seed, landed.tracks);
  const incomplete: string[] = [];

  const titles = { changed: 0, punctuationOnly: 0, examples: [] as { from: string; to: string }[] };
  const trackArtists = {
    changed: 0,
    examples: [] as { title: string; from: string[]; to: string[] }[],
  };
  const recordings = {
    reused: 0,
    created: 0,
    unknown: 0,
    reusedUnseeded: 0,
    seededKept: 0,
    seededReplaced: 0,
    titleChanged: 0,
    artistsChanged: 0,
    examples: [] as { from: string; to: string }[],
  };

  for (const { seed: s, landed: l } of pairs) {
    const title = compareTitle(s.title, l.title);
    if (title === 'punctuation') titles.punctuationOnly++;
    if (title === 'changed') {
      titles.changed++;
      if (titles.examples.length < EXAMPLES) titles.examples.push({ from: s.title, to: l.title });
    }
    if (!sameCredit(s.artists, l.artists, mbidOf)) {
      trackArtists.changed++;
      if (trackArtists.examples.length < EXAMPLES) {
        trackArtists.examples.push({
          title: l.title,
          from: s.artists.map((artist) => artist.name),
          to: l.artists.map((artist) => artist.name),
        });
      }
    }
  }

  // Recordings are counted over every landed track: an added track's
  // recording is reused or created like any other.
  const pairedByLanded = new Map(pairs.map((pair) => [pair.landed, pair.seed]));
  for (const track of landed.tracks) {
    const origin = origins.get(track.recording.mbid) ?? 'unknown';
    recordings[origin]++;
    const s = pairedByLanded.get(track);
    if (s?.recordingMbid) {
      if (s.recordingMbid === track.recording.mbid) recordings.seededKept++;
      else recordings.seededReplaced++;
    }
    if (origin === 'reused' && s?.recordingMbid !== track.recording.mbid) {
      recordings.reusedUnseeded++;
    }
    if (origin !== 'created' || !s) continue;
    if (compareTitle(s.title, track.recording.title) === 'changed') {
      recordings.titleChanged++;
      if (recordings.examples.length < EXAMPLES) {
        recordings.examples.push({ from: s.title, to: track.recording.title });
      }
    }
    if (!sameCredit(s.artists, track.recording.artists, mbidOf)) recordings.artistsChanged++;
  }
  if (recordings.unknown > 0) {
    incomplete.push(`couldn't tell whether ${recordings.unknown} recording(s) were new or reused`);
  }

  const releaseGroup: ReleaseCorrectionRecord['releaseGroup'] =
    landed.releaseGroup.otherReleases === null
      ? 'unknown'
      : landed.releaseGroup.otherReleases > 0
        ? 'reused'
        : 'new';
  if (releaseGroup === 'unknown')
    incomplete.push("couldn't read the release group's other releases");

  let releaseArtist: ReleaseCorrectionRecord['releaseArtist'] = null;
  if (seed.albumArtists.length > 0) {
    releaseArtist = {
      changed: !sameCredit(seed.albumArtists, landed.artists, mbidOf),
      from: seed.albumArtists.map((artist) => artist.name),
      to: landed.artists.map((artist) => artist.name),
    };
  } else {
    incomplete.push('the seed has no album artist to compare with');
  }
  const releaseTitle = {
    changed: compareTitle(seed.title, landed.title) === 'changed',
    from: seed.title,
    to: landed.title,
  };

  const moved = movedCount(pairs);
  const corrections: CorrectionType[] = [];
  if (releaseTitle.changed) corrections.push('release-title');
  if (releaseArtist?.changed) corrections.push('release-artist');
  if (releaseGroup === 'reused' && input.seededReleaseGroup !== landed.releaseGroup.mbid) {
    corrections.push('release-group-reused');
  }
  if (titles.changed > 0) corrections.push('track-titles');
  if (titles.punctuationOnly > 0) corrections.push('track-title-punctuation');
  if (trackArtists.changed > 0) corrections.push('track-artists');
  if (recordings.reusedUnseeded > 0) corrections.push('recordings-reused');
  if (recordings.seededReplaced > 0) corrections.push('seeded-recordings-replaced');
  if (recordings.titleChanged > 0) corrections.push('recording-titles');
  if (recordings.artistsChanged > 0) corrections.push('recording-artists');
  if (added.length > 0) corrections.push('tracks-added');
  if (removed.length > 0) corrections.push('tracks-removed');
  if (moved > 0) corrections.push('tracks-moved');

  const { kind, why } = albumKind({
    releaseGroup,
    media: landed.media,
    composers: input.composers,
  });

  return {
    version: 1,
    releaseMbid: landed.mbid,
    releaseTitle: landed.title,
    releaseGroupMbid: landed.releaseGroup.mbid,
    baselineSource: input.baselineSource,
    kind,
    kindWhy: why,
    tracks: {
      seeded: seed.tracks.length,
      landed: landed.tracks.length,
      paired: pairs.length,
      added: added.length,
      removed: removed.length,
      moved,
      pairedBy: {
        isrc: pairs.filter((pair) => pair.by === 'isrc').length,
        position: pairs.filter((pair) => pair.by === 'position').length,
        duration: pairs.filter((pair) => pair.by === 'duration').length,
      },
    },
    albumTitle: releaseTitle,
    releaseArtist,
    titles,
    trackArtists,
    recordings,
    releaseGroup,
    corrections,
    incomplete,
  };
}

/* ---------------------------------------------------------------- summary */

export type CorrectionSummaryRow = {
  kind: AlbumKind;
  albums: number;
  /** No corrections found and every comparison was made. */
  untouched: number;
  /** No corrections found, but some comparison could not be made. */
  untouchedIncomplete: number;
  /** Correction types by how many albums of this kind needed them, most first. */
  byType: { type: CorrectionType; albums: number }[];
};

const KIND_ORDER: AlbumKind[] = [
  'single-composer',
  'compilation',
  'box-set',
  'new-edition',
  'unknown',
];

export function summariseCorrections(
  records: Pick<ReleaseCorrectionRecord, 'kind' | 'corrections' | 'incomplete'>[],
): CorrectionSummaryRow[] {
  const rows = new Map<AlbumKind, CorrectionSummaryRow & { counts: Map<CorrectionType, number> }>();
  for (const record of records) {
    const row = rows.get(record.kind) ?? {
      kind: record.kind,
      albums: 0,
      untouched: 0,
      untouchedIncomplete: 0,
      byType: [],
      counts: new Map(),
    };
    row.albums++;
    if (record.corrections.length === 0) {
      if (record.incomplete.length === 0) row.untouched++;
      else row.untouchedIncomplete++;
    }
    for (const type of record.corrections) row.counts.set(type, (row.counts.get(type) ?? 0) + 1);
    rows.set(record.kind, row);
  }
  return KIND_ORDER.flatMap((kind) => {
    const row = rows.get(kind);
    if (!row) return [];
    const { counts, ...rest } = row;
    return [
      {
        ...rest,
        byType: [...counts.entries()]
          .map(([type, albums]) => ({ type, albums }))
          .sort((a, b) => b.albums - a.albums || a.type.localeCompare(b.type)),
      },
    ];
  });
}
