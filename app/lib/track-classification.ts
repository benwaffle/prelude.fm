/**
 * Shared contract for `track_classification` and match_queue pipeline completion.
 *
 * The integration owner defines the table; reader/pipeline code reads and
 * writes through these types and the precedence helper below.
 */

export type TrackClassificationState = 'unreviewed' | 'classical' | 'not_classical' | 'uncertain';

export type TrackClassificationProvenance = 'musicbrainz' | 'manual' | 'llm_proposal';

/** Row shape of `track_classification`. */
export type TrackClassificationRow = {
  spotifyTrackId: string;
  state: TrackClassificationState;
  provenance: TrackClassificationProvenance;
  reason: string | null;
  evidenceMbid: string | null;
  decidedAt: Date;
};

/** MusicBrainz album-pass outcome stored on `match_queue.pipeline_outcome`. */
export type PipelineOutcome = 'ready' | 'unanchored' | 'unclassified' | 'not_classical';

/** Columns on `match_queue` written when an MB pass finishes a track. */
export type PipelineCompletion = {
  pipelineOutcome: PipelineOutcome;
  pipelineReason: string | null;
  pipelineCompletedAt: Date;
};

const PROVENANCE_RANK: Record<TrackClassificationProvenance, number> = {
  manual: 3,
  musicbrainz: 2,
  llm_proposal: 1,
};

/** A stored row is replaced only by equal or higher provenance. */
export function classificationMayBeReplaced(
  existing: Pick<TrackClassificationRow, 'provenance'>,
  incoming: Pick<TrackClassificationRow, 'provenance'>,
): boolean {
  return PROVENANCE_RANK[incoming.provenance] >= PROVENANCE_RANK[existing.provenance];
}
