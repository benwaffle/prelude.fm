'use server';

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { latestInvariantResults, type InvariantResult } from '@/lib/musicbrainz-invariants';
import { checkAuth } from './auth';

export type CacheHealth = {
  invariants: InvariantResult[];
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

  return { invariants: await latestInvariantResults(), cache: row };
}
