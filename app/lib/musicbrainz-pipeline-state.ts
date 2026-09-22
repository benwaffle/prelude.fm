import { and, eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { forChunks } from './db/chunked';
import { matchQueue, trackClassification } from './db/schema';
import {
  classificationMayBeReplaced,
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
 * Writes the durable result of one MusicBrainz pass without changing the
 * queue's lease/workflow vocabulary.
 */
export async function persistMusicBrainzTrackOutcomes(
  outcomes: PersistedTrackPassOutcome[],
  claimOwnerId?: string,
  completedAt = new Date(),
): Promise<void> {
  if (outcomes.length === 0) return;

  await db.transaction(async (transaction) => {
    const existingRows = await forChunks(
      outcomes.map((outcome) => outcome.spotifyTrackId),
      (chunk) =>
        transaction
          .select()
          .from(trackClassification)
          .where(inArray(trackClassification.spotifyTrackId, chunk)),
    );
    const existingByTrack = new Map(existingRows.map((row) => [row.spotifyTrackId, row]));

    for (const outcome of outcomes) {
      await transaction
        .update(matchQueue)
        .set({
          pipelineOutcome: outcome.state,
          pipelineReason: outcome.reason,
          pipelineCompletedAt: completedAt,
        })
        .where(
          and(
            eq(matchQueue.spotifyId, outcome.spotifyTrackId),
            claimOwnerId ? eq(matchQueue.claimOwnerId, claimOwnerId) : undefined,
          ),
        );

      // The worker observes manual decisions but never authors or refreshes
      // them. Its own classifications are MB-derived or parser proposals.
      if (outcome.classificationProvenance === 'manual') continue;

      const incoming = {
        spotifyTrackId: outcome.spotifyTrackId,
        state: outcome.classification,
        provenance: outcome.classificationProvenance,
        reason: outcome.reason,
        evidenceMbid: null,
        decidedAt: completedAt,
      };
      const existing = existingByTrack.get(outcome.spotifyTrackId);
      if (existing && !classificationMayBeReplaced(existing, incoming)) continue;

      await transaction
        .insert(trackClassification)
        .values(incoming)
        .onConflictDoUpdate({
          target: trackClassification.spotifyTrackId,
          set: {
            state: incoming.state,
            provenance: incoming.provenance,
            reason: incoming.reason,
            evidenceMbid: incoming.evidenceMbid,
            decidedAt: incoming.decidedAt,
          },
        });
      existingByTrack.set(outcome.spotifyTrackId, incoming);
    }
  });
}
