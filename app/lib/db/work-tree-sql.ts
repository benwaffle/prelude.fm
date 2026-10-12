import { sql, type SQL } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './index';
import { jsonList } from './chunked';
import { mbWork } from './schema';

// Recursive CTEs: one statement however deep. UNION (not UNION ALL) drops repeats, so a cycle ends
// the walk.

export function subtreeOf(seed: SQL): SQL {
  return sql`(with recursive tree(mbid) as (${seed} union select child.mbid from mb_work child join tree on child.parent_mbid = tree.mbid) select mbid from tree)`;
}

export function lineageOf(seed: SQL): SQL {
  return sql`(with recursive up(mbid) as (${seed} union select parent.parent_mbid from mb_work parent join up on parent.mbid = up.mbid where parent.parent_mbid is not null) select mbid from up)`;
}

/** `(root, mbid)` pairs: which of several works a part is filed under. */
export function rootedSubtreeOf(rootMbids: Iterable<string>): SQL {
  return sql`(with recursive tree(root, mbid) as (select value, value from (${jsonList(rootMbids)}) union select tree.root, child.mbid from mb_work child join tree on child.parent_mbid = tree.mbid) select root, mbid from tree)`;
}

export type WorkTreeRow = typeof mbWork.$inferSelect;

/** One generation of children so a reader can tell a work with parts from a leaf. */
export async function readWorkNeighbourhood(
  seedMbids: Iterable<string>,
  database: DatabaseExecutor = db,
): Promise<WorkTreeRow[]> {
  const seeds = [...new Set(seedMbids)];
  if (seeds.length === 0) return [];
  const lineage = lineageOf(jsonList(seeds));
  return database
    .select()
    .from(mbWork)
    .where(sql`${mbWork.mbid} in ${lineage} or ${mbWork.parentMbid} in ${lineage}`);
}
