import { sql, type SQL } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './index';
import { jsonList } from './chunked';
import { mbWork } from './schema';

/**
 * Walking the cached MusicBrainz work tree in SQL.
 *
 * A work tree is recursive and arbitrarily deep, so every walk is a recursive
 * CTE: one statement however deep the tree, instead of one round trip per
 * generation. UNION (not UNION ALL) drops a work already reached, so a cycle
 * in the cache ends the walk instead of looping; the projection reports the
 * cycle itself.
 *
 * Seeds are a one-column `select` — `jsonList(mbids)` for a list of any
 * length, or a query of the caller's own.
 */

/** The seed works and every work filed beneath them, as a subquery of MBIDs. */
export function subtreeOf(seed: SQL): SQL {
  return sql`(with recursive tree(mbid) as (${seed} union select child.mbid from mb_work child join tree on child.parent_mbid = tree.mbid) select mbid from tree)`;
}

/** The seed works and every work above them, as a subquery of MBIDs. */
export function lineageOf(seed: SQL): SQL {
  return sql`(with recursive up(mbid) as (${seed} union select parent.parent_mbid from mb_work parent join up on parent.mbid = up.mbid where parent.parent_mbid is not null) select mbid from up)`;
}

/**
 * Each seed paired with every work beneath it, the seed included, as a
 * `(root, mbid)` subquery: which of several works a part is filed under.
 */
export function rootedSubtreeOf(rootMbids: Iterable<string>): SQL {
  return sql`(with recursive tree(root, mbid) as (select value, value from (${jsonList(rootMbids)}) union select tree.root, child.mbid from mb_work child join tree on child.parent_mbid = tree.mbid) select root, mbid from tree)`;
}

export type WorkTreeRow = typeof mbWork.$inferSelect;

/**
 * The seed works, everything above them, and one generation of children of
 * all of those — the children so a reader can tell a work that has parts
 * from a leaf. One statement.
 */
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
