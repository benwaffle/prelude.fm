/**
 * Movements and numbers the reader still files apart from their parent work.
 *
 * Every cached work with a parent and a matched recording that `workLevelOf`
 * leaves where it is ("unresolved"), grouped by parent. Most are pieces in a
 * collection, which stay apart on purpose; the rest are where a new rule, or
 * a MusicBrainz title fix, would bring a work's movements together. Reads
 * only.
 *
 *   pnpm metadata:level-review          grouped by parent, largest first
 *   pnpm metadata:level-review --json   machine-readable
 */
import { loadEnvConfig } from '@next/env';
import { sql } from 'drizzle-orm';

type Row = {
  mbid: string;
  title: string | null;
  type: string | null;
  parentMbid: string;
  parentTitle: string | null;
  parentType: string | null;
  orderingKey: number | null;
  children: number;
};

async function main() {
  const json = process.argv.includes('--json');
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required (put it in .env.local or export it)');
  }
  const { db } = await import('@/lib/db');
  const { workLevelOf } = await import('@/lib/musicbrainz-work-level');

  const rows = await db.all<Row>(sql`
    select w.mbid, w.title, w.type, w.parent_mbid as parentMbid, p.title as parentTitle,
      p.type as parentType, w.ordering_key as orderingKey,
      (select count(*) from mb_work c where c.parent_mbid = w.mbid) as children
    from mb_work w
    join mb_work p on p.mbid = w.parent_mbid
    where exists (
      select 1 from mb_recording_work rw
      join track_recording tr on tr.recording_mbid = rw.recording_mbid
      where rw.work_mbid = w.mbid
    )`);

  const byParent = new Map<string, { title: string | null; works: Row[] }>();
  for (const row of rows) {
    const level = workLevelOf({
      mbid: row.mbid,
      title: row.title ?? '',
      type: row.type,
      parentMbid: row.parentMbid,
      parentTitle: row.parentTitle,
      parentType: row.parentType,
      hasChildren: row.children > 0,
      orderingKey: row.orderingKey,
    });
    if (level.reason !== 'unresolved') continue;
    const group = byParent.get(row.parentMbid) ?? { title: row.parentTitle, works: [] };
    group.works.push(row);
    byParent.set(row.parentMbid, group);
  }

  const groups = [...byParent.entries()]
    .map(([mbid, group]) => ({
      parentMbid: mbid,
      parentTitle: group.title,
      works: group.works
        .sort((left, right) => (left.orderingKey ?? 0) - (right.orderingKey ?? 0))
        .map((work) => ({ mbid: work.mbid, title: work.title, orderingKey: work.orderingKey })),
    }))
    .sort((left, right) => right.works.length - left.works.length);

  if (json) {
    console.log(JSON.stringify(groups, null, 2));
    return;
  }
  const total = groups.reduce((sum, group) => sum + group.works.length, 0);
  console.log(
    `${total} works with a matched recording are filed apart from ${groups.length} parents`,
  );
  for (const group of groups) {
    console.log(
      `\n${String(group.works.length).padStart(4)}  ${group.parentTitle ?? '(untitled)'}`,
    );
    for (const work of group.works.slice(0, 3))
      console.log(`        ${work.title ?? '(untitled)'}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
