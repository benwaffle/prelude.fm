'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mbArtist, mbWork } from '@/lib/db/schema';
import { composerOf, musicBrainzApi, parentPartOf } from '@/lib/musicbrainz';
import { readAndCacheWork } from '@/lib/musicbrainz-cache';
import { findMbid } from '@/lib/musicbrainz-manual-submissions';
import { checkAuth } from './auth';

/** Guard against a cycle in the parent chain; real trees are a few deep. */
const MAX_DEPTH = 8;

export type RefreshedWork = {
  mbid: string;
  title: string;
  /** Null when MusicBrainz no longer has the work (merged or removed). */
  found: boolean;
  composer: string | null;
};

/**
 * Re-read a work and every work above it from MusicBrainz.
 *
 * The cache otherwise keeps what it read first, so an edit made on
 * MusicBrainz (a composer added to a movement or its parent) never reached the
 * player. The parents are read too because a part with no composer of its own
 * takes its parent's.
 *
 * Takes a work MBID, or any link containing one: a prelude.fm work page or a
 * MusicBrainz work page.
 */
export async function refreshWorkFromMusicBrainz(input: string): Promise<RefreshedWork[]> {
  await checkAuth();
  const mbid = findMbid(input);
  if (!mbid) throw new Error('No work ID in that link');

  const source = musicBrainzApi('interactive');
  const read: RefreshedWork[] = [];
  const seen = new Set<string>();
  let next: string | null = mbid;
  while (next && !seen.has(next) && seen.size < MAX_DEPTH) {
    seen.add(next);
    const work = await readAndCacheWork(source, next);
    if (work) {
      read.push({
        mbid: work.id,
        title: work.title,
        found: true,
        composer: composerOf(work)?.name ?? null,
      });
      next = parentPartOf(work)?.id ?? null;
      continue;
    }
    // Gone from MusicBrainz; keep walking the parent we stored.
    const [row] = await db
      .select({ title: mbWork.title, parentMbid: mbWork.parentMbid, composer: mbArtist.name })
      .from(mbWork)
      .leftJoin(mbArtist, eq(mbArtist.mbid, mbWork.composerMbid))
      .where(eq(mbWork.mbid, next));
    read.push({
      mbid: next,
      title: row?.title ?? next,
      found: false,
      composer: row?.composer ?? null,
    });
    next = row?.parentMbid ?? null;
  }
  return read;
}
