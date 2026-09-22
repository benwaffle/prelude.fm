/**
 * Album coverage vocabulary.
 *
 * Kept out of the server-action file because a `"use server"` module may only
 * export async functions — a constant there fails at runtime, not at build.
 */

/**
 * Why an album is, or is not, anchored to MusicBrainz.
 *
 * Ordered by what each costs to fix, because that is the only thing that
 * decides what to do next. An album MusicBrainz already holds needs ISRCs
 * submitting, which is minutes; one it has never heard of needs the release
 * entering, which is an evening.
 */
export type AlbumState =
  /** Every track resolves to a MusicBrainz recording. MusicBrainz can speak for it. */
  | 'anchored'
  /** Some tracks resolve; the rest have no ISRC registered. */
  | 'partial'
  /** MusicBrainz has the release but none of our ISRCs reach it. */
  | 'needs_isrcs'
  /** No release carries this barcode. Someone has to add it. */
  | 'absent'
  /** Several releases carry the barcode, so none identifies this album. */
  | 'ambiguous'
  /** Nobody has asked MusicBrainz about this barcode yet. */
  | 'unchecked';

export const STATE_LABEL: Record<AlbumState, string> = {
  anchored: 'Anchored',
  partial: 'Partly anchored',
  needs_isrcs: 'Needs ISRCs',
  absent: 'Not in MusicBrainz',
  ambiguous: 'Barcode not unique',
  unchecked: 'Not checked',
};

/** What each album state costs to fix, said plainly. */
export const WHAT_IT_NEEDS: Record<AlbumState, string> = {
  anchored: 'MusicBrainz can describe every track. Nothing to do.',
  partial:
    'Some tracks resolve and some do not. Where MusicBrainz has the release, the rest need their ISRCs submitting; where it does not, these recordings are in MusicBrainz under some other release and this one still needs adding.',
  needs_isrcs:
    'MusicBrainz has the release but none of our ISRCs. Submitting them anchors the album.',
  absent:
    'No release with this barcode exists in MusicBrainz. It has to be added before anything else.',
  ambiguous:
    'Several releases share this barcode, so none identifies the album. Pick the right one by hand.',
  unchecked: 'Not yet looked up. Run `pnpm mb:backfill releases`.',
};

/** How anchoring relates to what the MusicBrainz reader shows in the player. */
export const COVERAGE_LISTENER_NOTE =
  'Anchored tracks show work, movement, and composer from MusicBrainz in the player. Unanchored tracks stay in the gap strip with an explicit reason — the parser guess is pipeline metadata only, not what listeners see.';

export type AlbumRow = {
  id: string;
  title: string;
  year: number | null;
  tracks: number;
  anchored: number;
  worksLinked: number;
  works: number;
  upc: string | null;
  mbReleaseId: string | null;
  candidates: number | null;
  state: AlbumState;
};

export type Coverage = {
  albums: number;
  tracks: number;
  anchoredTracks: number;
  byState: { state: AlbumState; albums: number; tracks: number }[];
};

export type AlbumTrackPart = {
  /** The work_part_v2 row, so a key never depends on the text being distinct. */
  partId: number;
  workId: number;
  workTitle: string;
  label: string | null;
  title: string | null;
};

export type AlbumTrackRow = {
  id: string;
  title: string;
  discNumber: number;
  trackNumber: number;
  isrc: string | null;
  recordingMbid: string | null;
  /**
   * The movements this track covers. Usually one, but a single Spotify track
   * can hold several — a whole prelude and fugue, or a set of variations — and
   * the catalogue models that deliberately.
   */
  parts: AlbumTrackPart[];
};
