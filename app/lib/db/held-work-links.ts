import { and, eq, isNotNull, ne, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './index';
import { jsonList } from './chunked';
import { mbRecordingWork, mbWorkProposal, trackRecording, trackWorkLink } from './schema';

/**
 * Which works the Spotify tracks we hold are of, with the precedence between
 * MusicBrainz and our own links applied here, once, in SQL.
 *
 * Our own link stands in only where MusicBrainz has none:
 *
 *  - a track anchored to a MusicBrainz recording is of the works MusicBrainz
 *    relates that recording to;
 *  - if MusicBrainz relates the recording to no work, of the work
 *    `mb_work_proposal` suggests for it (any suggestion nobody dismissed, at
 *    its own confidence);
 *  - a track with no MusicBrainz recording is of the work `track_work_link`
 *    linked it to.
 *
 * Every reader — the library facts, the classifier, the work page and the
 * catalogue — asks this, so none of them can disagree about it.
 */

export type HeldWorkLink = {
  spotifyTrackId: string;
  /** Null for a track with no MusicBrainz recording. */
  recordingMbid: string | null;
  workMbid: string;
  linkedBy: 'musicbrainz' | 'prelude';
  /** Our link's confidence; null for a MusicBrainz relation. */
  confidence: 'high' | 'medium' | 'low' | null;
};

/** Narrow by the tracks asked about, or by a subquery of work MBIDs. */
export type HeldWorkLinkScope = { tracks: Iterable<string> } | { works: SQL };

/** The work a proposal suggests (indexed). Its confidence is still read from the JSON. */
const proposedWorkMbid = sql<string>`${mbWorkProposal.workMbid}`;
const proposedConfidence = sql`json_extract(${mbWorkProposal.proposal}, '$.confidence')`;

function inScope(
  scope: HeldWorkLinkScope | undefined,
  track: SQLWrapper,
  work: SQLWrapper,
): SQL | undefined {
  if (!scope) return undefined;
  return 'tracks' in scope
    ? sql`${track} in (${jsonList(scope.tracks)})`
    : sql`${work} in ${scope.works}`;
}

/** One branch's columns, named so the union can be embedded and selected from. */
function columns(
  spotifyTrackId: SQLWrapper,
  recordingMbid: SQLWrapper,
  workMbid: SQLWrapper,
  linkedBy: HeldWorkLink['linkedBy'],
  confidence: SQLWrapper,
) {
  return {
    spotifyTrackId: sql<string>`${spotifyTrackId}`.as('spotify_track_id'),
    recordingMbid: sql<string | null>`${recordingMbid}`.as('recording_mbid'),
    workMbid: sql<string>`${workMbid}`.as('work_mbid'),
    linkedBy: sql<HeldWorkLink['linkedBy']>`${linkedBy}`.as('linked_by'),
    confidence: sql<HeldWorkLink['confidence']>`${confidence}`.as('confidence'),
  };
}

/**
 * The links as one `union all` query, its columns named `spotify_track_id`,
 * `recording_mbid`, `work_mbid`, `linked_by` and `confidence`: await it for
 * rows, or embed it in a larger statement.
 */
/** Without a scope, every held track. */
export function heldWorkLinks(
  scope: HeldWorkLinkScope | undefined,
  database: DatabaseExecutor = db,
) {
  const byMusicBrainz = database
    .select(
      columns(
        trackRecording.spotifyTrackId,
        trackRecording.recordingMbid,
        mbRecordingWork.workMbid,
        'musicbrainz',
        sql`null`,
      ),
    )
    .from(trackRecording)
    .innerJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, trackRecording.recordingMbid))
    .where(inScope(scope, trackRecording.spotifyTrackId, mbRecordingWork.workMbid));

  const byProposal = database
    .select(
      columns(
        trackRecording.spotifyTrackId,
        trackRecording.recordingMbid,
        proposedWorkMbid,
        'prelude',
        proposedConfidence,
      ),
    )
    .from(trackRecording)
    .innerJoin(mbWorkProposal, eq(mbWorkProposal.recordingMbid, trackRecording.recordingMbid))
    .where(
      and(
        ne(mbWorkProposal.status, 'dismissed'),
        isNotNull(proposedWorkMbid),
        sql`not exists (select 1 from ${mbRecordingWork} where ${mbRecordingWork.recordingMbid} = ${trackRecording.recordingMbid})`,
        inScope(scope, trackRecording.spotifyTrackId, proposedWorkMbid),
      ),
    );

  const byTrackLink = database
    .select(
      columns(
        trackWorkLink.spotifyTrackId,
        sql`null`,
        trackWorkLink.workMbid,
        'prelude',
        sql`'high'`,
      ),
    )
    .from(trackWorkLink)
    .where(
      and(
        isNotNull(trackWorkLink.workMbid),
        sql`not exists (select 1 from ${trackRecording} where ${trackRecording.spotifyTrackId} = ${trackWorkLink.spotifyTrackId})`,
        inScope(scope, trackWorkLink.spotifyTrackId, trackWorkLink.workMbid),
      ),
    );

  return byMusicBrainz.unionAll(byProposal).unionAll(byTrackLink);
}
