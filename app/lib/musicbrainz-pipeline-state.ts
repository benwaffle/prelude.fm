import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from './db';
import { matchQueue, trackClassification } from './db/schema';
import {
  PROVENANCE_RANK,
  type PipelineOutcome,
  type TrackClassificationProvenance,
  type TrackClassificationState,
} from './track-classification';

export type PersistedTrackPassOutcome = {
  spotifyTrackId: string;
  state: PipelineOutcome;
  classification: TrackClassificationState;
  classificationProvenance: TrackClassificationProvenance;
  reason: string;
};

/**
 * The queue status each pass outcome leaves a track in, and whether the
 * worker lets go of it.
 *
 * Deliberately coarse: `ready` is `matched`, a track MusicBrainz itself
 * files as non-classical is `not_classical`, and both ways of not knowing —
 * `unanchored`, `unclassified` — are `unresolved`, which no worker should
 * hold. The durable difference between those two is `pipeline_outcome`, so
 * repeating it in the lease vocabulary would give two places to disagree.
 */
const QUEUE_STATUS: Record<
  PipelineOutcome,
  { status: 'matched' | 'not_classical' | 'unresolved'; releaseClaim: boolean }
> = {
  ready: { status: 'matched', releaseClaim: false },
  not_classical: { status: 'not_classical', releaseClaim: false },
  unanchored: { status: 'unresolved', releaseClaim: true },
  unclassified: { status: 'unresolved', releaseClaim: true },
};

/** `classificationMayBeReplaced`, in SQL, against the stored row. */
function storedRankAtMost(incoming: TrackClassificationProvenance): SQL {
  const rank = sql.join(
    Object.entries(PROVENANCE_RANK).map(
      ([provenance, value]) => sql`when ${provenance} then ${value}`,
    ),
    sql` `,
  );
  return sql`(case ${trackClassification.provenance} ${rank} end) <= ${PROVENANCE_RANK[incoming]}`;
}

/**
 * Writes everything one MusicBrainz pass decided about its tracks, as one
 * batch: each track's outcome and queue status, and its classification
 * where provenance precedence lets the pass replace the stored one. A crash
 * leaves all of it or none, never an outcome that disagrees with its status.
 *
 * Only rows still held by `claimOwnerId` are touched in the queue.
 */
export async function recordAlbumPassOutcomes(
  outcomes: PersistedTrackPassOutcome[],
  claimOwnerId: string,
  completedAt = new Date(),
): Promise<void> {
  if (outcomes.length === 0) return;
  const [first, ...rest] = outcomes.flatMap((outcome) => {
    const { status, releaseClaim } = QUEUE_STATUS[outcome.state];
    const queue = db
      .update(matchQueue)
      .set({
        pipelineOutcome: outcome.state,
        pipelineReason: outcome.reason,
        pipelineCompletedAt: completedAt,
        status,
        processedAt: completedAt,
        // The reason belongs to the pass, not to a failure, and it is already
        // in `pipeline_reason`. In the error column an admin list of errors
        // would report a gap in MusicBrainz as something the worker got wrong.
        errorMessage: null,
        ...(releaseClaim ? { claimOwnerId: null } : {}),
      })
      .where(
        and(
          eq(matchQueue.spotifyId, outcome.spotifyTrackId),
          eq(matchQueue.claimOwnerId, claimOwnerId),
        ),
      );
    // The worker observes manual decisions but never authors or refreshes
    // them. Its own classifications are MB-derived or parser proposals.
    if (outcome.classificationProvenance === 'manual') return [queue];
    const classification = {
      state: outcome.classification,
      provenance: outcome.classificationProvenance,
      reason: outcome.reason,
      evidenceMbid: null,
      decidedAt: completedAt,
    };
    return [
      queue,
      db
        .insert(trackClassification)
        .values({ spotifyTrackId: outcome.spotifyTrackId, ...classification })
        .onConflictDoUpdate({
          target: trackClassification.spotifyTrackId,
          set: classification,
          setWhere: storedRankAtMost(outcome.classificationProvenance),
        }),
    ];
  });
  await db.batch([first, ...rest]);
}
