/**
 * What the reader must be handed before it can project anything.
 *
 * This is the boundary between the query adapter and the projection: every
 * classical identity and descriptive field below comes from a cached `mb_*`
 * fact, and the provider fields describe playback occurrences only. There is
 * deliberately no place for a legacy work row, a parser title, or a parser
 * form — an adapter that cannot fill a field leaves it null and the
 * projection reports the gap.
 */

export type TrackClassificationState = 'unreviewed' | 'classical' | 'not_classical' | 'uncertain';

export type TrackClassification = {
  spotifyTrackId: string;
  state: TrackClassificationState;
  provenance: 'musicbrainz' | 'manual' | 'llm_proposal';
  reason: string | null;
};

export type ReleaseResolution =
  | { state: 'not_checked' }
  | { state: 'missing' }
  | { state: 'ambiguous'; candidateMbids: string[] }
  | { state: 'misaligned'; releaseMbid: string; reason: string }
  | { state: 'matched'; releaseMbid: string };

export type ProviderAlbumFact = {
  spotifyAlbumId: string;
  title: string;
  imageUrl: string | null;
  popularity: number | null;
  releaseResolution: ReleaseResolution;
};

export type ProviderTrackFact = {
  spotifyTrackId: string;
  title: string;
  spotifyAlbumId: string;
  discNumber: number;
  trackNumber: number;
  durationMs: number;
  popularity: number | null;
};

export type AcceptedAnchorFact = {
  spotifyTrackId: string;
  state: 'accepted';
  recordingMbid: string;
  matchedBy: 'isrc' | 'release_position' | 'reordered_title_duration';
  isrc: string | null;
};

export type ConflictingAnchorFact = {
  spotifyTrackId: string;
  state: 'conflicting';
  candidateRecordingMbids: string[];
  reason: string;
};

export type TrackAnchorFact = AcceptedAnchorFact | ConflictingAnchorFact;

export type MbRecordingFact = {
  mbid: string;
  title: string | null;
  lengthMs: number | null;
  detail: 'stub' | 'full';
};

export type MbRecordingWorkFact = {
  recordingMbid: string;
  workMbid: string;
};

export type MbWorkFact = {
  mbid: string;
  title: string | null;
  type: string | null;
  parentMbid: string | null;
  orderingKey: number | null;
  composerMbid: string | null;
  detail: 'stub' | 'full';
};

export type MbWorkCatalogueFact = {
  workMbid: string;
  seriesMbid: string;
  system: string;
  number: string;
  normalizedSystem: string;
  normalizedNumber: string;
};

export type MbArtistFact = {
  mbid: string;
  name: string | null;
  creditedName: string | null;
  sortName: string | null;
  type: string | null;
  beginYear: number | null;
  endYear: number | null;
};

export type MbRecordingCreditFact = {
  recordingMbid: string;
  artistMbid: string;
  role: string;
  instrument: string | null;
};

export type MbReleaseFact = {
  mbid: string;
  title: string | null;
  date: string | null;
  country: string | null;
  /**
   * Unknown means this cached release predates authoritative `url-rels`
   * ingestion. Missing is only valid after that fetch completed.
   */
  spotifyFreeStreamingUrlState: 'unknown' | 'present' | 'missing';
};

export type MbReleaseTrackFact = {
  releaseMbid: string;
  medium: number;
  position: number;
  recordingMbid: string;
  title: string | null;
  lengthMs: number | null;
};

export type MusicBrainzLibraryFacts = {
  requestedTrackIds: string[];
  classifications: TrackClassification[];
  providerAlbums: ProviderAlbumFact[];
  providerTracks: ProviderTrackFact[];
  anchors: TrackAnchorFact[];
  mbRecordings: MbRecordingFact[];
  mbRecordingWorks: MbRecordingWorkFact[];
  mbWorks: MbWorkFact[];
  mbWorkCatalogues: MbWorkCatalogueFact[];
  mbArtists: MbArtistFact[];
  mbRecordingCredits: MbRecordingCreditFact[];
  mbReleases: MbReleaseFact[];
  mbReleaseTracks: MbReleaseTrackFact[];
};
