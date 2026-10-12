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

export async function countTrackClassificationStates(
  trackIds: string[],
): Promise<
  Pick<
    AnonymousImportRunInput,
    'classicalCount' | 'uncertainCount' | 'notClassicalCount' | 'unreviewedCount'
  >
> {
  if (trackIds.length === 0) {
    return { classicalCount: 0, uncertainCount: 0, notClassicalCount: 0, unreviewedCount: 0 };
  }
  const { db } = await import('./db');
  const { trackClassification } = await import('./db/schema');
  const { inArray } = await import('drizzle-orm');
  const counts = { classical: 0, uncertain: 0, not_classical: 0, unreviewed: 0 };
  const CHUNK = 400;
  for (let start = 0; start < trackIds.length; start += CHUNK) {
    const batch = trackIds.slice(start, start + CHUNK);
    const rows = await db
      .select({ state: trackClassification.state })
      .from(trackClassification)
      .where(inArray(trackClassification.spotifyTrackId, batch));
    for (const row of rows) counts[row.state]++;
  }
  return {
    classicalCount: counts.classical,
    uncertainCount: counts.uncertain,
    notClassicalCount: counts.not_classical,
    unreviewedCount: trackIds.length - counts.classical - counts.uncertain - counts.not_classical,
  };
}

/** No user id, no track membership. */
export type AnonymousImportRunInput = {
  startedAt: Date;
  completedAt: Date;
  inputTrackCount: number;
  classicalCount: number;
  uncertainCount: number;
  notClassicalCount: number;
  unreviewedCount: number;
  albumsAlreadyCached: number;
  albumsNew: number;
  requestsCaused: number;
};
