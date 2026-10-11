/**
 * Movements and numbers the reader still files apart from their parent work.
 *
 * Every cached work with a parent and a matched recording that `workLevelOf`
 * leaves where it is ("unresolved"), grouped by parent. Most are pieces in a
 * collection, which stay apart on purpose; the rest are where a new rule, or
 * a MusicBrainz title fix, would bring a work's movements together. Reads
 * only.
 *
 *   pnpm metadata:level-review               grouped by parent, largest first
 *   pnpm metadata:level-review --json        machine-readable
 *   pnpm metadata:level-review --duplicates  also: cards that list a movement
 *                                            twice, across every cached track
 *
 * A movement listed twice is usually two tracks of one movement (a cadenza
 * or a part split across tracks), which is real. Anything else is a bug.
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

  const duplicates = process.argv.includes('--duplicates') ? await findDuplicates() : [];

  if (json) {
    console.log(JSON.stringify({ apart: groups, duplicates }, null, 2));
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
  if (process.argv.includes('--duplicates')) {
    console.log(`\n${duplicates.length} cards list a movement more than once`);
    for (const card of duplicates) {
      console.log(`  ${card.title ?? '(untitled)'} — ${card.album}: ${card.repeated.join('; ')}`);
    }
  }
}

/** Cards, over every cached track, that list the same movement twice. */
async function findDuplicates() {
  const { db } = await import('@/lib/db');
  const { spotifyTrack } = await import('@/lib/db/schema');
  const { loadMusicBrainzLibraryFacts } = await import('@/app/actions/library-musicbrainz');
  const { projectMusicBrainzLibrary } = await import('@/lib/musicbrainz-library');
  const { musicBrainzLibraryView } = await import('@/lib/musicbrainz-library-view');

  const ids = (await db.select({ id: spotifyTrack.spotifyId }).from(spotifyTrack)).map(
    (row) => row.id,
  );
  const { works } = musicBrainzLibraryView(
    projectMusicBrainzLibrary(await loadMusicBrainzLibraryFacts(ids)),
    new Set(),
  );
  return works.flatMap((work) => {
    const counts = new Map<string, number>();
    for (const movement of work.movements) {
      const key = `${movement.roman ? `${movement.roman}. ` : ''}${movement.name}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated = [...counts]
      .filter(([, count]) => count > 1)
      .map(([name, count]) => `${name} ×${count}`);
    return repeated.length > 0
      ? [{ id: work.id, title: work.title, album: work.album, repeated }]
      : [];
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
