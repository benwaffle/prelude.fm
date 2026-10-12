/** Not in the server-action file: a "use server" module may only export async functions. */

/** Ordered by what each costs to fix. */
export type AlbumState =
  | 'anchored'
  | 'partial'
  | 'needs_isrcs'
  | 'absent'
  | 'ambiguous'
  | 'unchecked';

export const STATE_LABEL: Record<AlbumState, string> = {
  anchored: 'All linked',
  partial: 'Partly linked',
  needs_isrcs: 'Needs ISRCs',
  absent: 'Not in MusicBrainz',
  ambiguous: 'Barcode not unique',
  unchecked: 'Not checked',
};

export const WHAT_IT_NEEDS: Record<AlbumState, string> = {
  anchored: 'MusicBrainz can describe every track. Nothing to do.',
  partial:
    'Some tracks resolve and some do not. Where MusicBrainz has the release, the rest need their ISRCs submitting; where it does not, these recordings are in MusicBrainz under some other release and this one still needs adding.',
  needs_isrcs:
    'MusicBrainz has the release but none of our ISRCs. Submitting them links the album’s tracks.',
  absent:
    'No release with this barcode exists in MusicBrainz. It has to be added before anything else.',
  ambiguous:
    'Several releases share this barcode, so none identifies the album. Pick the right one by hand.',
  unchecked: 'Not yet looked up. Run `pnpm mb:backfill releases`.',
};

export type AlbumRow = {
  id: string;
  title: string;
  year: number | null;
  tracks: number;
  anchored: number;
  classified: number;
  classical: number;
  tracksReachingWork: number;
  works: number;
  worksCached: number;
  upc: string | null;
  mbReleaseId: string | null;
  candidates: number | null;
  state: AlbumState;
};

export type AlbumTrackWork = {
  mbid: string;
  title: string | null;
  detail: 'stub' | 'full' | null;
  parentMbid: string | null;
  parentTitle: string | null;
};

export type AlbumTrackRow = {
  id: string;
  title: string;
  discNumber: number;
  trackNumber: number;
  isrc: string | null;
  recordingMbid: string | null;
  recordingTitle: string | null;
  recordingDetail: 'stub' | 'full' | null;
  classification: {
    state: 'unreviewed' | 'classical' | 'not_classical' | 'uncertain';
    provenance: 'musicbrainz' | 'manual' | 'llm_proposal';
    reason: string | null;
  } | null;
  /** An empty list is authoritative only when the recording itself has full detail. */
  works: AlbumTrackWork[];
};
