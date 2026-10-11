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

/**
 * Whether each track belongs in the classical library, and why.
 *
 * In order of precedence:
 *
 *  1. The film-score rule (`film-scores`). A standing decision about what the
 *     catalogue holds, so it outranks a stored verdict and fresh MusicBrainz
 *     evidence alike. Applied as tracks are read rather than stored, so it
 *     covers albums imported later too.
 *  2. With `preferStored`, the durable `track_classification` row. The reader
 *     wants this. The pipeline does not: it must weigh current MusicBrainz
 *     evidence before provenance precedence is applied, or an old parser
 *     proposal would hide stronger new evidence and could never be upgraded.
 *  3. What MusicBrainz's evidence supports (`classify`).
 *
 * Reads only what those need, so a job that wants a verdict does not pay for
 * the whole library read.
 */
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
    // A track whose ISRC names recordings but which we could not anchor —
    // two recordings, usually — still has MusicBrainz evidence. Without it the
    // track would be filed as unclassified and the contradiction, the thing
    // worth contributing a fix for, would never be reported.
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
  // Only an unanchored track has candidates, and MusicBrainz's relations
  // outrank our own track link; an anchored track's links already apply
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

/**
 * Of these composers, those MusicBrainz catalogues at least one work by (any
 * work in the cache). Special-purpose artists such as [traditional] never are.
 */
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

/**
 * There is no classification store yet, so this states what the existing rows
 * actually support and nothing more.
 *
 * Specific MusicBrainz evidence — a catalogue-series reference or an
 * art-music work type — is deterministic and outranks the parser, and where
 * they disagree the reason says so. A work relation on its own is not
 * evidence: MusicBrainz files works for popular songs too. `match_queue`'s
 * `not_classical` is an LLM verdict and is labelled the proposal it is.
 * Everything else stays visible as uncertain or unreviewed, which is the
 * honest reading of "nobody has established this".
 */
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
  // We looked and MusicBrainz did not settle it. That is a different state
  // from never having looked, and the reader shows both.
  return {
    spotifyTrackId,
    state: workMbids.length > 0 ? 'uncertain' : 'unreviewed',
    provenance: 'musicbrainz',
    reason: evidence.reason,
  };
}
