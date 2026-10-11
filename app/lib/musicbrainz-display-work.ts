import { workLevelOf, type WorkLevel } from './musicbrainz-work-level';

/**
 * Which MusicBrainz work a recording is shown under, and what that work is
 * called, numbered and by whom.
 *
 * The library card, the catalogue and the catalogue's work heading all ask
 * this, and they have to agree: clicking a card's catalogue number must land
 * on a work the catalogue files under the same composer and number. So the
 * rule lives here, pure, and each of them only reads the cache into a
 * `WorkIndex`.
 *
 * The rule:
 *
 *  - the work shown is the one `workLevelOf` picks — the related work, or the
 *    work it is a part of;
 *  - its catalogue references are its own, else the nearest ancestor's that
 *    has any, sorted by system and number so the first is the same wherever
 *    it is read. Climbing is reading MusicBrainz, not guessing: MusicBrainz
 *    says this work is a part of that one, and that one is BWV 988;
 *  - its composer is its own, else the nearest ancestor's. MusicBrainz files
 *    the composer on the piece, not on each movement, so this is a choice
 *    between values MusicBrainz actually holds.
 */

export type DisplayWorkNode = {
  mbid: string;
  title: string | null;
  type: string | null;
  parentMbid: string | null;
  orderingKey: number | null;
  composerMbid: string | null;
};

export type DisplayWorkReference = {
  workMbid: string;
  normalizedSystem: string;
  normalizedNumber: string;
};

export type WorkIndex<N extends DisplayWorkNode, R extends DisplayWorkReference> = {
  workById: Map<string, N>;
  /** Works some cached work names as its parent: the ones with parts. */
  parentMbids: Set<string>;
  referencesByWork: Map<string, R[]>;
};

export function indexWorks<N extends DisplayWorkNode, R extends DisplayWorkReference>(
  works: N[],
  references: R[],
): WorkIndex<N, R> {
  const referencesByWork = new Map<string, R[]>();
  for (const reference of references) {
    referencesByWork.set(reference.workMbid, [
      ...(referencesByWork.get(reference.workMbid) ?? []),
      reference,
    ]);
  }
  return {
    workById: new Map(works.map((work) => [work.mbid, work])),
    parentMbids: new Set(
      works.map((work) => work.parentMbid).filter((mbid): mbid is string => mbid !== null),
    ),
    referencesByWork,
  };
}

/** Why a climb up the tree stopped before reaching a work with no parent. */
export type HierarchyBreak =
  | { kind: 'cycle'; mbid: string }
  | { kind: 'parent-missing'; parentMbid: string; childMbid: string };

export type WorkAttributes<R> = {
  /** The nearest references at or above the work, sorted; empty when none. */
  references: R[];
  /** The nearest composer at or above the work. */
  composerMbid: string | null;
};

export type DisplayWork<
  N extends DisplayWorkNode,
  R extends DisplayWorkReference,
> = WorkAttributes<R> & {
  /** The related work, or null when the cache does not hold it. */
  related: N | null;
  /** The related work and then its ancestors, as far as the cache goes. */
  hierarchy: N[];
  hierarchyBreak: HierarchyBreak | null;
  /** Null only when the related work is not cached. */
  level: WorkLevel | null;
  /** The work shown, when the cache holds it. */
  display: N | null;
};

/** The work and then its ancestors, nearest first, and why the climb stopped. */
export function climb<N extends DisplayWorkNode>(
  workMbid: string,
  workById: Map<string, N>,
): { chain: N[]; stopped: HierarchyBreak | null } {
  const chain: N[] = [];
  const visited = new Set<string>();
  let cursor = workById.get(workMbid);
  while (cursor) {
    if (visited.has(cursor.mbid)) return { chain, stopped: { kind: 'cycle', mbid: cursor.mbid } };
    visited.add(cursor.mbid);
    chain.push(cursor);
    if (!cursor.parentMbid) break;
    const parent = workById.get(cursor.parentMbid);
    if (!parent) {
      return {
        chain,
        stopped: { kind: 'parent-missing', parentMbid: cursor.parentMbid, childMbid: cursor.mbid },
      };
    }
    cursor = parent;
  }
  return { chain, stopped: null };
}

/** References and composer for a work, read from it and then its ancestors. */
export function workAttributes<N extends DisplayWorkNode, R extends DisplayWorkReference>(
  ancestorsNearestFirst: N[],
  index: WorkIndex<N, R>,
): WorkAttributes<R> {
  const carrier = ancestorsNearestFirst.find(
    (work) => (index.referencesByWork.get(work.mbid) ?? []).length > 0,
  );
  return {
    references: [...(carrier ? index.referencesByWork.get(carrier.mbid)! : [])].sort(
      (left, right) =>
        left.normalizedSystem.localeCompare(right.normalizedSystem) ||
        left.normalizedNumber.localeCompare(right.normalizedNumber),
    ),
    composerMbid: ancestorsNearestFirst.find((work) => work.composerMbid)?.composerMbid ?? null,
  };
}

export function resolveDisplayWork<N extends DisplayWorkNode, R extends DisplayWorkReference>(
  relatedMbid: string,
  index: WorkIndex<N, R>,
): DisplayWork<N, R> {
  const related = index.workById.get(relatedMbid) ?? null;
  if (!related) {
    return {
      related: null,
      hierarchy: [],
      hierarchyBreak: null,
      level: null,
      display: null,
      references: [],
      composerMbid: null,
    };
  }
  const { chain, stopped } = climb(relatedMbid, index.workById);
  const parent = related.parentMbid ? index.workById.get(related.parentMbid) : undefined;
  const level = workLevelOf({
    mbid: related.mbid,
    title: related.title ?? '',
    type: related.type,
    parentMbid: related.parentMbid,
    parentTitle: parent?.title ?? null,
    parentType: parent?.type ?? null,
    hasChildren: index.parentMbids.has(related.mbid),
    orderingKey: related.orderingKey,
  });
  const start = chain.findIndex((work) => work.mbid === level.mbid);
  return {
    related,
    hierarchy: chain,
    hierarchyBreak: stopped,
    level,
    display: index.workById.get(level.mbid) ?? null,
    ...workAttributes(start === -1 ? [] : chain.slice(start), index),
  };
}
