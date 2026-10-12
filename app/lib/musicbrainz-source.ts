// One implementation today (the web service). The interface keeps a future local mirror a config
// change; nothing above it may call `mbGet` directly.

export type MbRelation = {
  type: string;
  'type-id'?: string;
  direction: 'forward' | 'backward';
  'target-type'?: string;
  /** A part's position within its parent, on the backward `parts` relation. */
  'ordering-key'?: number;
  'attribute-values'?: Record<string, string>;
  attributes?: string[];
  begin?: string | null;
  end?: string | null;
  ended?: boolean;
  work?: { id: string; title: string };
  artist?: { id: string; name: string };
  series?: { id: string; name: string; type?: string };
  url?: { id?: string; resource: string };
};

export type MbReleaseUrlRelation = {
  url: string;
  relationshipType: string;
  relationshipTypeId: string;
  ended: boolean;
  begin: string | null;
  end: string | null;
  attributes: string[];
};

export type MbWork = {
  id: string;
  title: string;
  type?: string | null;
  relations?: MbRelation[];
};

export type MbArtist = {
  id: string;
  name: string;
  'sort-name'?: string | null;
  type?: string | null;
  'life-span'?: { begin?: string | null; end?: string | null };
  relations?: MbRelation[];
};

export type MbRecordingSearchHit = {
  id: string;
  title: string;
  score?: number;
  length?: number | null;
  isrcs?: string[];
  releases?: { 'release-group'?: { id: string; title: string } }[];
};

export type MbWorkRef = { id: string; title: string };

// Production roles are kept: which roles a reader cares about is the reader's business, not the
// cache's.
export type MbCredit = {
  artistId: string;
  name: string;
  role: string;
  instrument: string | null;
};

export type MbReleaseRecording = {
  id: string;
  title: string;
  length: number | null;
  isrcs: string[];
  works: MbWorkRef[];
  credits: MbCredit[];
  // Carries the printed Latin-script name (Дмитрий Синьковский credited as Dmitry Sinkovsky)
  // without a second request.
  artistCredit: { artistId: string; name: string }[];
};

export type MbReleaseTrack = {
  /** One-based. */
  medium: number;
  /** One-based. */
  position: number;
  /** As printed on this release, which may differ from the recording's. */
  title: string;
  length: number | null;
  recording: MbReleaseRecording;
};

export type MbRelease = {
  id: string;
  title: string;
  barcode: string | null;
  date: string | null;
  country: string | null;
  /** Always present from the API source; optional for test/mirror adapters written before URL caching. */
  urlRelations?: MbReleaseUrlRelation[];
  tracks: MbReleaseTrack[];
};

export interface MusicBrainzSource {
  readonly name: string;

  releasesByBarcode(barcode: string): Promise<string[]>;

  // Track count goes in the query: a common title would otherwise return dozens of candidates to
  // rule out.
  searchReleases(title: string, trackCount: number): Promise<string[]>;

  /** One coarse read: a single request where per-recording reads would be dozens. */
  releaseWithRecordings(releaseId: string): Promise<MbRelease | null>;

  releaseRecordingIds(releaseId: string): Promise<string[]>;

  recordingsByIsrc(isrcs: string[]): Promise<Map<string, string>>;

  recordingWorks(recordingId: string): Promise<MbWorkRef[]>;

  // For tracks reached by ISRC rather than by release, where no release read carries this along.
  recordingDetail(recordingId: string): Promise<MbReleaseRecording | null>;

  work(workId: string): Promise<MbWork | null>;

  artist(artistId: string): Promise<MbArtist | null>;
}
