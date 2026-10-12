import { workLevelOf, type WorkLevel } from './musicbrainz-work-level';

// The card, catalogue and work heading must agree, so the rule lives here. References and composer
// are the work's own, else the nearest ancestor's: MusicBrainz files them on the piece, not each
// movement.

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

export type HierarchyBreak =
  | { kind: 'cycle'; mbid: string }
  | { kind: 'parent-missing'; parentMbid: string; childMbid: string };

export type WorkAttributes<R> = {
  references: R[];
  composerMbid: string | null;
};

export type DisplayWork<
  N extends DisplayWorkNode,
  R extends DisplayWorkReference,
> = WorkAttributes<R> & {
  related: N | null;
  hierarchy: N[];
  hierarchyBreak: HierarchyBreak | null;
  /** Null only when the related work is not cached. */
  level: WorkLevel | null;
  display: N | null;
};

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
  // A movement of a section ("III. Sequenz: a. Dies irae") belongs to the whole Requiem, so keep
  // climbing while each level is a part of the next.
  let level = levelOf(related, index);
  for (let step = 1; step < chain.length && chain[step].mbid === level.mbid; step++) {
    const next = levelOf(chain[step], index);
    if (next.mbid === chain[step].mbid) break;
    level = next;
  }
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

function levelOf<N extends DisplayWorkNode, R extends DisplayWorkReference>(
  work: N,
  index: WorkIndex<N, R>,
): WorkLevel {
  const parent = work.parentMbid ? index.workById.get(work.parentMbid) : undefined;
  return workLevelOf({
    mbid: work.mbid,
    title: work.title ?? '',
    type: work.type,
    parentMbid: work.parentMbid,
    parentTitle: parent?.title ?? null,
    parentType: parent?.type ?? null,
    hasChildren: index.parentMbids.has(work.mbid),
    orderingKey: work.orderingKey,
  });
}
