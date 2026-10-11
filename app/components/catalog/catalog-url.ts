/**
 * Where the catalogue is, as its URL says: /catalog?composer=…&work=…. The
 * URL carries it so the back gesture steps back through it and a work can
 * be linked to.
 */
export interface CatalogUrlState {
  composerId: string | null;
  workId: string | null;
  /**
   * Which pane a phone shows, one at a time: 0 composers, 1 works,
   * 2 recordings. The desk shows all three.
   */
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
