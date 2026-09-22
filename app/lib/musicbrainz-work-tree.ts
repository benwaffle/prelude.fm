/**
 * Walking a cached MusicBrainz work tree.
 *
 * MusicBrainz files a catalogue number, a work type and a composer on the
 * piece rather than on its movements, so almost every question the reader
 * asks of a work is really a question about the nearest ancestor that has an
 * answer. Every copy of that walk has to stop at a cycle in the cache, and
 * one that forgets runs forever, so the walk lives here.
 *
 * The projection keeps its own loop: it reports a cycle and a missing parent
 * as gaps while it climbs, which is more than a walk.
 */

export type WorkTreeNode = {
  mbid: string;
  parentMbid: string | null;
};

/** The work and then its ancestors, nearest first. Stops at a cycle. */
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

/** The nearest work at or above `workMbid` that answers the question. */
export function nearestAncestorWith<T extends WorkTreeNode>(
  workMbid: string,
  byMbid: Map<string, T>,
  answers: (node: T) => boolean,
): T | null {
  return ancestry(workMbid, byMbid).find(answers) ?? null;
}
