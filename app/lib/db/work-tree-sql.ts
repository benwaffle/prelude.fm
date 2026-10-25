import { and, getTableColumns, is, sql, SQL, type SQLWrapper } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './index';
import { jsonList } from './chunked';
import { mbWork, mbWorkCatalogue, ownWork, ownWorkCatalogue } from './schema';

// A work is a MusicBrainz work or one of ours MusicBrainz lacks (`own_work`), and either id may
// name the other's parent. Each table is filtered on its own: SQLite does not push an `in
// (subquery)` into a UNION ALL view, so a view would scan all of `mb_work`. `+mb_work_mbid is null`
// keeps SQLite off that column's index, which would visit every own work for each step of a walk.

// Recursive CTEs: one statement however deep. UNION (not UNION ALL) drops repeats, so a cycle ends
// the walk.

export function subtreeOf(seed: SQL): SQL {
  return sql`(with recursive tree(mbid) as (${seed} union select child.mbid from mb_work child join tree on child.parent_mbid = tree.mbid union select child.id from own_work child join tree on child.parent_id = tree.mbid where +child.mb_work_mbid is null) select mbid from tree)`;
}

export function lineageOf(seed: SQL): SQL {
  return sql`(with recursive up(mbid) as (${seed} union select parent.parent_mbid from mb_work parent join up on parent.mbid = up.mbid where parent.parent_mbid is not null union select parent.parent_id from own_work parent join up on parent.id = up.mbid where parent.parent_id is not null and +parent.mb_work_mbid is null) select mbid from up)`;
}

export type WorkSource = 'musicbrainz' | (typeof ownWork.$inferSelect)['source'];
export type WorkTreeRow = typeof mbWork.$inferSelect & { source: WorkSource };

/** Ids, or an (unparenthesised) select of them, like `jsonList`. */
type WorkIds = Iterable<string> | SQL;
const idList = (ids: WorkIds) => (is(ids, SQL) ? ids : jsonList(ids));

/** Rows of either kind, in `mb_work`'s shape; `where` is given each table's id and parent. */
export function selectWorks(
  where: (id: SQLWrapper, parent: SQLWrapper) => SQL,
  database: DatabaseExecutor = db,
) {
  return database
    .select({ ...getTableColumns(mbWork), source: sql<WorkSource>`'musicbrainz'` })
    .from(mbWork)
    .where(where(mbWork.mbid, mbWork.parentMbid))
    .unionAll(
      database
        .select({
          mbid: ownWork.id,
          title: ownWork.title,
          type: ownWork.type,
          parentMbid: ownWork.parentId,
          orderingKey: ownWork.orderingKey,
          composerMbid: ownWork.composerMbid,
          imslpUrl: sql<string | null>`null`,
          detail: sql<'stub' | 'full'>`'full'`,
          fetchedAt: ownWork.createdAt,
          source: sql<WorkSource>`${ownWork.source}`,
        })
        .from(ownWork)
        .where(and(sql`+${ownWork.mbWorkMbid} is null`, where(ownWork.id, ownWork.parentId))),
    );
}

/**
 * One generation of children so a reader can tell a work with parts from a leaf, or with
 * `wholeTrees` every part under each ancestor, so a reader can list the parts a recording lacks.
 */
export async function readWorkNeighbourhood(
  seedMbids: WorkIds,
  database: DatabaseExecutor = db,
  { wholeTrees = false } = {},
): Promise<WorkTreeRow[]> {
  if (!is(seedMbids, SQL) && [...seedMbids].length === 0) return [];
  const lineage = lineageOf(idList(seedMbids));
  const tree = subtreeOf(sql`select mbid from ${lineage}`);
  return selectWorks(
    (id, parent) =>
      wholeTrees ? sql`${id} in ${tree}` : sql`${id} in ${lineage} or ${parent} in ${lineage}`,
    database,
  );
}

/** Catalogue numbers of either kind of work. Ours name no MusicBrainz series: theirs is ''. */
export function readWorkCatalogue(workIds: WorkIds, database: DatabaseExecutor = db) {
  const ids = idList(workIds);
  return database
    .select(getTableColumns(mbWorkCatalogue))
    .from(mbWorkCatalogue)
    .where(sql`${mbWorkCatalogue.workMbid} in (${ids})`)
    .unionAll(
      database
        .select({
          workMbid: ownWorkCatalogue.workId,
          seriesMbid: sql<string>`''`,
          system: ownWorkCatalogue.system,
          number: ownWorkCatalogue.number,
          normalizedSystem: ownWorkCatalogue.normalizedSystem,
          normalizedNumber: ownWorkCatalogue.normalizedNumber,
        })
        .from(ownWorkCatalogue)
        .where(sql`${ownWorkCatalogue.workId} in (${ids})`),
    );
}
