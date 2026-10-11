/**
 * Read into the cache every work a suggested work link names, so the player
 * can show it under its composer and parent.
 *
 *   pnpm metadata:cache-proposed-works
 *
 * Spends MusicBrainz requests on the backfill channel; works already read in
 * full cost nothing. Writes only the `mb_*` cache.
 */
import { defineScript } from './lib/cli';

defineScript({ options: {} }, async () => {
  const { cacheProposedWorks } = await import('@/lib/track-work-links-run');
  const { requests, works } = await cacheProposedWorks();
  console.log(`${works} suggested works read into the cache, ${requests} MusicBrainz requests.`);
});
