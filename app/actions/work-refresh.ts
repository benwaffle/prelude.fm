'use server';

import { eq } from 'drizzle-orm';
import { checkAuth } from '@/app/admin/actions/auth';
import { db } from '@/lib/db';
import { mbWork } from '@/lib/db/schema';
import { musicBrainzApi, parentPartOf } from '@/lib/musicbrainz';
import { readAndCacheWork } from '@/lib/musicbrainz-cache';

/** Guard against a cycle in the parent chain; real trees are a few deep. */
const MAX_DEPTH = 8;

/**
 * Re-read a work and every work above it from MusicBrainz.
 *
 * The cache otherwise keeps what it read first, so an edit made on
 * MusicBrainz (a composer added to a movement or its parent) never reached the
 * page. The parents are read too because a part with no composer of its own
 * takes its parent's.
 */
export async function refreshWorkFromMusicBrainz(workMbid: string): Promise<{ read: number }> {
  await checkAuth();
  const source = musicBrainzApi('interactive');
  const seen = new Set<string>();
  let next: string | null = workMbid;
  while (next && !seen.has(next) && seen.size < MAX_DEPTH) {
    seen.add(next);
    const work = await readAndCacheWork(source, next);
    if (!work) {
      // Gone from MusicBrainz (merged or removed); keep walking what we stored.
      const [row] = await db
        .select({ parentMbid: mbWork.parentMbid })
        .from(mbWork)
        .where(eq(mbWork.mbid, next));
      next = row?.parentMbid ?? null;
      continue;
    }
    next = parentPartOf(work)?.id ?? null;
  }
  return { read: seen.size };
}
