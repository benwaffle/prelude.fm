// Usage: pnpm metadata:cache-proposed-works
// Spends backfill-channel requests; works already read in full cost nothing.
import { defineScript } from './lib/cli';

defineScript({ options: {} }, async () => {
  const { cacheProposedWorks } = await import('@/lib/track-work-links-run');
  const { requests, works } = await cacheProposedWorks();
  console.log(`${works} suggested works read into the cache, ${requests} MusicBrainz requests.`);
});
