export type TrackClassificationState = 'unreviewed' | 'classical' | 'not_classical' | 'uncertain';

export type TrackClassificationProvenance = 'musicbrainz' | 'manual' | 'llm_proposal';

export type TrackClassificationRow = {
  spotifyTrackId: string;
  state: TrackClassificationState;
  provenance: TrackClassificationProvenance;
  reason: string | null;
  evidenceMbid: string | null;
  decidedAt: Date;
};

export type PipelineOutcome = 'ready' | 'unanchored' | 'unclassified' | 'not_classical';

export const PROVENANCE_RANK: Record<TrackClassificationProvenance, number> = {
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
