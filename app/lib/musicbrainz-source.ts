// Two implementations: the web service (`musicbrainz.ts`) and the local mirror over our own `mb_*`
// tables (`musicbrainz-mirror.ts`), which asks the web service only for what the tables lack.
// Nothing above this interface may call `mbGet` directly.

const answeredFromCache = new WeakSet<object>();

/** Marks an answer read from our own tables rather than from MusicBrainz. */
export function markCachedAnswer<T extends object>(answer: T): T {
  answeredFromCache.add(answer);
  return answer;
}

/** An answer read from our own tables cost no request, and writing it back would change nothing. */
export function isCachedAnswer(answer: unknown): boolean {
  return typeof answer === 'object' && answer !== null && answeredFromCache.has(answer);
}

/** The MusicBrainz requests an answer cost: none when it came from our tables. */
export function requestsSpent(answer: unknown): 0 | 1 {
  return isCachedAnswer(answer) ? 0 : 1;
}

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

  // Releases whose MusicBrainz URL relationships name this Spotify album: MusicBrainz stating the
  // identity. Optional, and answered from our tables only: asking the web service would add a
  // request to every album for links the cached releases already carry.
  releasesLinkedToSpotifyAlbum?(spotifyAlbumId: string): Promise<string[]>;

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
