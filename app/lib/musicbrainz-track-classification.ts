import { and, eq, notLike, sql, type SQLWrapper } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './db';
import { jsonList } from './db/chunked';
import { heldWorkLinks } from './db/held-work-links';
import {
  mbArtist,
  mbRecordingIsrc,
  mbRecordingWork,
  mbWork,
  mbWorkCatalogue,
  matchQueue,
  spotifyTrack,
  trackClassification,
  trackRecording,
} from './db/schema';
import { readWorkNeighbourhood } from './db/work-tree-sql';
import { filmScoreInputs } from './film-score-inputs';
import { filmScoreReason } from './film-scores';
import { classicalEvidenceFor, type ClassicalEvidenceWork } from './musicbrainz-classical-evidence';
import type { TrackClassification } from './musicbrainz-library-facts';

// Precedence: the film-score rule, then (with `preferStored`) the stored row, then MusicBrainz
// evidence. The pipeline omits `preferStored` so new evidence can upgrade an old parser proposal.
export async function classifyTracks(
  spotifyTrackIds: string[],
  options: { preferStored: boolean },
  database: DatabaseExecutor = db,
): Promise<TrackClassification[]> {
  const requested = Array.from(new Set(spotifyTrackIds));
  if (requested.length === 0) return [];
  const inRequested = (column: SQLWrapper) => sql`${column} in (${jsonList(requested)})`;

  const [links, candidateRows, filmScoreInputOf, queueRows, storedRows] = await Promise.all([
    heldWorkLinks({ tracks: requested }, database),
    // An ISRC that names recordings we couldn't anchor (usually two) is still MusicBrainz evidence;
    // without it the contradiction would never be reported.
    database
      .select({ spotifyTrackId: spotifyTrack.spotifyId, workMbid: mbRecordingWork.workMbid })
      .from(spotifyTrack)
      .innerJoin(mbRecordingIsrc, eq(mbRecordingIsrc.isrc, spotifyTrack.isrc))
      .innerJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, mbRecordingIsrc.recordingMbid))
      .where(
        and(
          inRequested(spotifyTrack.spotifyId),
          sql`not exists (select 1 from ${trackRecording} where ${trackRecording.spotifyTrackId} = ${spotifyTrack.spotifyId})`,
        ),
      )
      .orderBy(mbRecordingIsrc.recordingMbid, mbRecordingWork.workMbid),
    filmScoreInputs(requested, database),
    database
      .select({ spotifyTrackId: matchQueue.spotifyId, status: matchQueue.status })
      .from(matchQueue)
      .where(inRequested(matchQueue.spotifyId)),
    options.preferStored
      ? database
          .select()
          .from(trackClassification)
          .where(inRequested(trackClassification.spotifyTrackId))
      : [],
  ]);

  const worksByTrack = (rows: { spotifyTrackId: string; workMbid: string }[]) => {
    const byTrack = new Map<string, string[]>();
    for (const row of rows) {
      byTrack.set(row.spotifyTrackId, [...(byTrack.get(row.spotifyTrackId) ?? []), row.workMbid]);
    }
    return byTrack;
  };
  const linkedWorks = worksByTrack(
    [...links].sort((left, right) => left.workMbid.localeCompare(right.workMbid)),
  );
  const candidateWorks = worksByTrack(candidateRows);
  // MusicBrainz's relations outrank our own track link; an anchored track's links already apply
  // that precedence.
  const workMbidsOf = (spotifyTrackId: string) =>
    candidateWorks.get(spotifyTrackId) ?? linkedWorks.get(spotifyTrackId) ?? [];

  const works = await readWorkNeighbourhood(requested.flatMap(workMbidsOf), database);
  const [catalogueRows, catalogedComposers] = await Promise.all([
    database
      .selectDistinct({ workMbid: mbWorkCatalogue.workMbid })
      .from(mbWorkCatalogue)
      .where(sql`${mbWorkCatalogue.workMbid} in (${jsonList(works.map((work) => work.mbid))})`),
    catalogedComposerMbids(
      works.flatMap((work) => (work.composerMbid ? [work.composerMbid] : [])),
      database,
    ),
  ]);
  const workByMbid = new Map(works.map((work) => [work.mbid, work]));
  const catalogedWorkMbids = new Set(catalogueRows.map((row) => row.workMbid));
  const queueStatusByTrack = new Map(queueRows.map((row) => [row.spotifyTrackId, row.status]));
  const storedByTrack = new Map(storedRows.map((row) => [row.spotifyTrackId, row]));

  return requested.map((spotifyTrackId): TrackClassification => {
    const workMbids = workMbidsOf(spotifyTrackId);
    const filmScore = filmScoreReason(
      { workMbids, ...filmScoreInputOf(spotifyTrackId) },
      workByMbid,
      catalogedWorkMbids,
    );
    if (filmScore) {
      return { spotifyTrackId, state: 'not_classical', provenance: 'manual', reason: filmScore };
    }
    const stored = storedByTrack.get(spotifyTrackId);
    if (stored) {
      return {
        spotifyTrackId,
        state: stored.state,
        provenance: stored.provenance,
        reason: stored.reason,
      };
    }
    return classify(
      spotifyTrackId,
      workMbids,
      workByMbid,
      catalogedWorkMbids,
      catalogedComposers,
      queueStatusByTrack.get(spotifyTrackId) ?? null,
    );
  });
}

/** Special-purpose artists such as [traditional] never are. */
export async function catalogedComposerMbids(
  composerMbids: string[],
  database: DatabaseExecutor = db,
): Promise<Set<string>> {
  if (composerMbids.length === 0) return new Set();
  const rows = await database
    .selectDistinct({ composerMbid: mbWork.composerMbid })
    .from(mbWork)
    .innerJoin(mbWorkCatalogue, eq(mbWorkCatalogue.workMbid, mbWork.mbid))
    .innerJoin(mbArtist, eq(mbArtist.mbid, mbWork.composerMbid))
    .where(
      and(
        sql`${mbWork.composerMbid} in (${jsonList(composerMbids)})`,
        notLike(mbArtist.name, '[%'),
      ),
    );
  return new Set(rows.map((row) => row.composerMbid!));
}

// Specific MusicBrainz evidence outranks the parser; a work relation alone is not evidence.
// `match_queue`'s `not_classical` is an LLM verdict, labelled as a proposal. Everything else stays
// visibly uncertain or unreviewed.
function classify(
  spotifyTrackId: string,
  workMbids: string[],
  workByMbid: Map<string, ClassicalEvidenceWork>,
  catalogedWorkMbids: Set<string>,
  catalogedComposerMbids: Set<string>,
  queueStatus: string | null,
): TrackClassification {
  const evidence = classicalEvidenceFor(
    workMbids,
    workByMbid,
    catalogedWorkMbids,
    catalogedComposerMbids,
  );
  if (evidence.state === 'classical') {
    return {
      spotifyTrackId,
      state: 'classical',
      provenance: 'musicbrainz',
      reason:
        queueStatus === 'not_classical'
          ? `${evidence.reason}, but the parser ruled this not classical`
          : evidence.reason,
    };
  }
  if (queueStatus === 'not_classical') {
    return {
      spotifyTrackId,
      state: 'not_classical',
      provenance: 'llm_proposal',
      reason: `the album parser ruled this not classical; not reviewed by hand (${evidence.reason})`,
    };
  }
  // We looked and MusicBrainz did not settle it: a different state from never having looked.
  return {
    spotifyTrackId,
    state: workMbids.length > 0 ? 'uncertain' : 'unreviewed',
    provenance: 'musicbrainz',
    reason: evidence.reason,
  };
}
