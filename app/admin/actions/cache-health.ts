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
  /**
   * Works whose place in the tree the rules could not settle.
   *
   * Each is a childless, untyped work whose title does not name its parent.
   * It is either a movement whose parent is titled differently or a piece
   * inside a collection, and those want opposite answers. They are left where
   * they are and counted here rather than guessed at, because collapsing a
   * piece into its collection is invisible once done.
   */
  unsettled: { count: number; samples: UnsettledWorkLevel[] };
  cache: {
    albums: number;
    albumsCached: number;
    tracks: number;
    tracksAnchored: number;
    tracksByIsrc: number;
    tracksReachingWork: number;
    works: number;
    worksRead: number;
    worksWithParent: number;
    credits: number;
    catalogues: number;
  };
};

/** What the MusicBrainz cache holds, and whether it is sound. */
export async function getCacheHealth(): Promise<CacheHealth> {
  await checkAuth();

  const [row] = await db.all<CacheHealth['cache']>(sql`
    select
      (select count(*) from spotify_album) as albums,
      (select count(*) from spotify_album a
         where exists (select 1 from mb_release r where r.mbid = a.mb_release_id)) as albumsCached,
      (select count(*) from spotify_track) as tracks,
      (select count(*) from track_recording) as tracksAnchored,
      (select count(*) from track_recording where matched_by = 'isrc') as tracksByIsrc,
      (select count(*) from track_recording tr
         where exists (select 1 from mb_recording_work w
                       where w.recording_mbid = tr.recording_mbid)) as tracksReachingWork,
      (select count(*) from mb_work) as works,
      (select count(*) from mb_work where detail = 'full') as worksRead,
      (select count(*) from mb_work where parent_mbid is not null) as worksWithParent,
      (select count(*) from mb_recording_credit) as credits,
      (select count(*) from mb_work_catalogue) as catalogues
  `);

  const unsettledRows = await db.all<UnsettledWorkLevel & { n: number }>(sql`
    select w.mbid, w.title, p.title as parentTitle,
           (select count(*) from mb_work u
              left join mb_work up on up.mbid = u.parent_mbid
             where u.type is null and u.parent_mbid is not null
               and not exists (select 1 from mb_work c where c.parent_mbid = u.mbid)
               and u.title not like up.title || ':%') as n
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
      samples: unsettledRows.map(({ mbid, title, parentTitle }) => ({ mbid, title, parentTitle })),
    },
    cache: row,
  };
}
