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

// Deliberately coarse: both ways of not knowing are `unresolved`; `pipeline_outcome` keeps the
// durable difference.
const QUEUE_STATUS: Record<
  PipelineOutcome,
  { status: 'matched' | 'not_classical' | 'unresolved'; releaseClaim: boolean }
> = {
  ready: { status: 'matched', releaseClaim: false },
  not_classical: { status: 'not_classical', releaseClaim: false },
  unanchored: { status: 'unresolved', releaseClaim: true },
  unclassified: { status: 'unresolved', releaseClaim: true },
};

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
 * One batch, so a crash never leaves an outcome that disagrees with its status.
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
        // The reason is in `pipeline_reason`; in the error column a MusicBrainz gap would read as a
        // worker failure.
        errorMessage: null,
        ...(releaseClaim ? { claimOwnerId: null } : {}),
      })
      .where(
        and(
          eq(matchQueue.spotifyId, outcome.spotifyTrackId),
          eq(matchQueue.claimOwnerId, claimOwnerId),
        ),
      );
    // The worker observes manual decisions but never authors or refreshes them.
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
