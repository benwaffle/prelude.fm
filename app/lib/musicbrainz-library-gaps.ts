export type MusicBrainzGapCode =
  | 'provider-track-not-fetched'
  | 'provider-album-not-fetched'
  | 'classification-unreviewed'
  | 'classification-uncertain'
  | 'classification-not-classical'
  | 'release-not-checked'
  | 'release-missing'
  | 'release-ambiguous'
  | 'release-tracklist-misaligned'
  | 'release-cache-missing'
  | 'release-title-missing'
  | 'release-date-missing'
  | 'release-spotify-streaming-url-missing'
  | 'release-track-position-mismatch'
  | 'recording-unanchored'
  | 'recording-anchor-conflict'
  | 'recording-cache-missing'
  | 'recording-stub'
  | 'recording-title-missing'
  | 'recording-work-missing'
  | 'work-cache-missing'
  | 'work-stub'
  | 'work-title-missing'
  | 'work-type-missing'
  | 'work-catalogue-missing'
  | 'work-composer-missing'
  | 'composer-cache-missing'
  | 'composer-name-missing'
  | 'work-hierarchy-parent-missing'
  | 'work-hierarchy-cycle'
  | 'work-level-ambiguous'
  | 'work-linked-by-us'
  | 'recording-credits-missing'
  | 'recording-credit-artist-missing';

export type MusicBrainzGap = {
  code: MusicBrainzGapCode;
  entity: 'track' | 'album' | 'recording' | 'work' | 'artist' | 'release';
  entityId: string;
  detail: string | null;
};

export function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function pushGap(gaps: MusicBrainzGap[], gap: MusicBrainzGap): void {
  const duplicate = gaps.some(
    (candidate) =>
      candidate.code === gap.code &&
      candidate.entity === gap.entity &&
      candidate.entityId === gap.entityId &&
      candidate.detail === gap.detail,
  );
  if (!duplicate) gaps.push(gap);
}

export function gap(
  code: MusicBrainzGapCode,
  entity: MusicBrainzGap['entity'],
  entityId: string,
  detail: string | null = null,
): MusicBrainzGap {
  return { code, entity, entityId, detail };
}
