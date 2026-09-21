/**
 * Deciding which MusicBrainz work each of ours is.
 *
 * Anchoring gave us tracks → recordings → the works those recordings perform.
 * Rolling that up says which MusicBrainz work one of our works corresponds
 * to, which is what makes the hierarchy reachable: a work with no MBID has no
 * parent and no siblings however well the cache is filled.
 *
 * The rule is unanimity, and it is strict on purpose. Linking two of our
 * works to one MusicBrainz work quietly asserts they are the same piece, and
 * that is the error that nearly merged seven distinct Bach preludes earlier
 * in this work. A disagreement between a work's own tracks is exactly the
 * signal that something upstream is wrong, so it stops rather than votes.
 */

export type ReachedWork = {
  /** One of our works. */
  workId: number;
  /** A MusicBrainz work one of its tracks performs, resolved to display level. */
  mbid: string;
  /** How many of the work's tracks reached it. */
  tracks: number;
};

export type LinkDecision =
  | { workId: number; mbid: string; reason: 'unanimous' }
  | { workId: number; mbid: null; reason: 'nothing-reached' | 'divided' | 'contested' };

/**
 * Link a work only when every one of its tracks agrees, and only when no
 * other work of ours already claims that MusicBrainz work.
 *
 * `claimedBy` maps a MusicBrainz work to the work of ours already linked to
 * it. Two of ours pointing at one of theirs is a claim that they are the same
 * piece, which is a merge, and merges are not something to infer from a
 * rollup.
 */
export function decideWorkLinks(
  reached: ReachedWork[],
  claimedBy: Map<string, number> = new Map(),
): LinkDecision[] {
  const byWork = new Map<number, ReachedWork[]>();
  for (const row of reached) {
    byWork.set(row.workId, [...(byWork.get(row.workId) ?? []), row]);
  }

  const decisions: LinkDecision[] = [];
  const claimedInThisPass = new Map(claimedBy);

  for (const [workId, rows] of byWork) {
    if (rows.length === 0) {
      decisions.push({ workId, mbid: null, reason: 'nothing-reached' });
      continue;
    }
    const distinct = new Set(rows.map((row) => row.mbid));
    if (distinct.size > 1) {
      decisions.push({ workId, mbid: null, reason: 'divided' });
      continue;
    }

    const [mbid] = [...distinct];
    const claimant = claimedInThisPass.get(mbid);
    if (claimant !== undefined && claimant !== workId) {
      decisions.push({ workId, mbid: null, reason: 'contested' });
      continue;
    }

    claimedInThisPass.set(mbid, workId);
    decisions.push({ workId, mbid, reason: 'unanimous' });
  }

  return decisions;
}
