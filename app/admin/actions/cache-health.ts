'use server';

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { latestInvariantResults, type InvariantResult } from '@/lib/musicbrainz-invariants';
import { checkAuth } from './auth';

export type UnsettledWorkLevel = {
  mbid: string;
  title: string;
  parentTitle: string | null;
};

export type CacheHealth = {
  invariants: InvariantResult[];
  // Left in place and counted rather than guessed at: collapsing a piece into its collection is
  // invisible once done.
  unsettled: { count: number; capped: boolean; samples: UnsettledWorkLevel[] };
};

// Counted up to this many: there are ~45k in the dump, and counting them all reads all of
// `mb_work` (644k rows) on every visit to the page.
const UNSETTLED_COUNT_CAP = 1000;

export async function getCacheHealth(): Promise<CacheHealth> {
  await checkAuth();

  const unsettledRows = await db.all<UnsettledWorkLevel & { n: number }>(sql`
    select w.mbid, w.title, p.title as parentTitle,
           (select count(*) from (select 1 from mb_work u
              join mb_work up on up.mbid = u.parent_mbid
             where u.type is null
               and not exists (select 1 from mb_work c where c.parent_mbid = u.mbid)
               and u.title not like up.title || ':%'
             limit ${UNSETTLED_COUNT_CAP})) as n
      from mb_work w join mb_work p on p.mbid = w.parent_mbid
     where w.type is null
       and not exists (select 1 from mb_work c where c.parent_mbid = w.mbid)
       and w.title not like p.title || ':%'
     limit 8
  `);

  return {
    invariants: await latestInvariantResults(),
    unsettled: {
      count: unsettledRows[0]?.n ?? 0,
      capped: (unsettledRows[0]?.n ?? 0) >= UNSETTLED_COUNT_CAP,
      samples: unsettledRows.map(({ mbid, title, parentTitle }) => ({ mbid, title, parentTitle })),
    },
  };
}
