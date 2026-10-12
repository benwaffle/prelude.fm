// MusicBrainz files catalogue number, type and composer on the piece, not its movements, so most
// questions climb the tree. The walk lives here so every copy stops at cycles.

export type WorkTreeNode = {
  mbid: string;
  parentMbid: string | null;
};

/** Stops at a cycle. */
export function ancestry<T extends WorkTreeNode>(workMbid: string, byMbid: Map<string, T>): T[] {
  const chain: T[] = [];
  const seen = new Set<string>();
  let cursor = byMbid.get(workMbid);
  while (cursor && !seen.has(cursor.mbid)) {
    seen.add(cursor.mbid);
    chain.push(cursor);
    cursor = cursor.parentMbid ? byMbid.get(cursor.parentMbid) : undefined;
  }
  return chain;
}
