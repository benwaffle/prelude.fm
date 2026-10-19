import { and, eq, isNotNull, ne, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './index';
import { jsonList } from './chunked';
import { mbRecordingWork, mbWorkProposal, trackRecording, trackWorkLink } from './schema';

// MusicBrainz relations first; our own link (an undismissed `mb_work_proposal`, or
// `track_work_link` for a track with no recording) only where MusicBrainz has none. An approved
// proposal also replaces a MusicBrainz relation, for one MusicBrainz has wrong (a Handel recording
// filed under Mozart). Every reader asks this, so none can disagree.

export type HeldWorkLink = {
  spotifyTrackId: string;
  /** Null for a track with no MusicBrainz recording. */
  recordingMbid: string | null;
  workMbid: string;
  linkedBy: 'musicbrainz' | 'prelude';
  /** Null for a MusicBrainz relation. */
  confidence: 'high' | 'medium' | 'low' | null;
};

export type HeldWorkLinkScope = { tracks: Iterable<string> } | { works: SQL };

/** Indexed column; its confidence is still read from the JSON. */
const proposedWorkMbid = sql<string>`${mbWorkProposal.workMbid}`;
const proposedConfidence = sql`json_extract(${mbWorkProposal.proposal}, '$.confidence')`;
const approved = sql`${mbWorkProposal.status} = 'approved' and ${proposedWorkMbid} is not null`;

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
    .where(
      and(
        sql`not exists (select 1 from ${mbWorkProposal} where ${mbWorkProposal.recordingMbid} = ${trackRecording.recordingMbid} and ${approved})`,
        inScope(scope, trackRecording.spotifyTrackId, mbRecordingWork.workMbid),
      ),
    );

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
        sql`(${approved} or not exists (select 1 from ${mbRecordingWork} where ${mbRecordingWork.recordingMbid} = ${trackRecording.recordingMbid}))`,
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
