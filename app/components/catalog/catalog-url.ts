export interface CatalogUrlState {
  composerId: string | null;
  workId: string | null;
  /** Phones show one pane: 0 composers, 1 works, 2 recordings. */
  level: 0 | 1 | 2;
}

type SearchReader = Pick<URLSearchParams, 'get'>;

export function parseCatalogUrl(search: SearchReader): CatalogUrlState {
  const composerId = search.get('composer')?.trim() || null;
  const workId = search.get('work')?.trim() || null;
  return { composerId, workId, level: workId ? 2 : composerId ? 1 : 0 };
}

export function catalogHref(composerId: string | null, workId: string | null = null): string {
  const params = new URLSearchParams();
  if (composerId) params.set('composer', composerId);
  if (workId) params.set('work', workId);
  const query = params.toString();
  return query ? `/catalog?${query}` : '/catalog';
}
