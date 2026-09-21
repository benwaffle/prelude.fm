/**
 * The MusicBrainz reads the application depends on, as an interface.
 *
 * Today there is one implementation: the web service, in `musicbrainz.ts`.
 * A local mirror is the obvious second one, and the only reason to name this
 * boundary now is that the choice between them is a capacity decision we
 * cannot yet make. The web service is rate-limited to one request per second;
 * a mirror removes that limit and costs an always-on PostgreSQL replica plus a
 * licensing conversation, because replication packets are CC BY-NC-SA.
 *
 * Keeping the app behind this interface means that decision stays a
 * configuration change rather than a rewrite. Nothing above this line may
 * reach for `mbGet` directly.
 */

export type MbRelation = {
  type: string;
  direction: 'forward' | 'backward';
  'target-type'?: string;
  /** A part's position within its parent, on the backward `parts` relation. */
  'ordering-key'?: number;
  'attribute-values'?: Record<string, string>;
  attributes?: string[];
  work?: { id: string; title: string };
  artist?: { id: string; name: string };
  series?: { id: string; name: string; type?: string };
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
};

export type MbRecordingSearchHit = {
  id: string;
  title: string;
  score?: number;
  isrcs?: string[];
};

/** A work as it appears on a recording's `performance` relationship. */
export type MbWorkRef = { id: string; title: string };

/**
 * One artist's part in a recording.
 *
 * `role` is the MusicBrainz relationship type — `conductor`, `performing
 * orchestra`, `instrument`, `vocal` — and `instrument` carries the attribute
 * that qualifies it, so a violinist is `instrument` + `violin` rather than a
 * role of its own. Production roles (`producer`, `engineer`, `mix`) arrive
 * through the same list and are kept: deciding which roles a reader cares
 * about is the reader's business, not the cache's.
 */
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
  /**
   * The artists as this release credits them.
   *
   * Worth keeping apart from the relationship credits because it carries the
   * name the label printed, which for an artist whose MusicBrainz name is in
   * another script is the only Latin form we get without a second request:
   * the violinist filed as Дмитрий Синьковский is credited here as Dmitry
   * Sinkovsky.
   */
  artistCredit: { artistId: string; name: string }[];
};

export type MbReleaseTrack = {
  /** Medium position, i.e. the disc number, one-based. */
  medium: number;
  /** Track position within the medium, one-based. */
  position: number;
  /** The title as printed on this release, which may differ from the recording's. */
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
  tracks: MbReleaseTrack[];
};

export interface MusicBrainzSource {
  /** Which implementation answered, for logging and for admin. */
  readonly name: string;

  /** Release MBIDs whose own barcode is exactly this one. */
  releasesByBarcode(barcode: string): Promise<string[]>;

  /**
   * Release MBIDs whose title matches and which carry exactly this many
   * tracks, best match first.
   *
   * The track count belongs in the query rather than in a filter afterwards:
   * the search index knows it, and a common title would otherwise return
   * dozens of candidates that each cost a request to rule out.
   */
  searchReleases(title: string, trackCount: number): Promise<string[]>;

  /**
   * A release with its tracklist, recordings, ISRCs, work relationships and
   * credits.
   *
   * This is deliberately one coarse read rather than several fine ones: over
   * the web service it is a single request where the per-recording equivalent
   * would be dozens, and that ratio is what makes the API viable at all.
   */
  releaseWithRecordings(releaseId: string): Promise<MbRelease | null>;

  /** Just the recording MBIDs a release contains, in order. */
  releaseRecordingIds(releaseId: string): Promise<string[]>;

  /** ISRC -> recording MBID, for the ISRCs that resolve. */
  recordingsByIsrc(isrcs: string[]): Promise<Map<string, string>>;

  /** The works a recording is a performance of. */
  recordingWorks(recordingId: string): Promise<MbWorkRef[]>;

  /**
   * One recording with its works and credits.
   *
   * The counterpart to `releaseWithRecordings` for tracks reached by ISRC
   * rather than by release — the albums MusicBrainz does not hold, where
   * there is no release read to carry this information along with it.
   */
  recordingDetail(recordingId: string): Promise<MbReleaseRecording | null>;

  /** A work with its parent, composer and catalogue relationships. */
  work(workId: string): Promise<MbWork | null>;

  artist(artistId: string): Promise<MbArtist | null>;
}
