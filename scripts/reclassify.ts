// Usage: pnpm metadata:reclassify
// Hand decisions are never replaced.
import { defineScript } from './lib/cli';

defineScript({ options: {} }, async () => {
  const [{ db }, { spotifyTrack }, { reclassify }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('@/lib/track-work-links-run'),
  ]);
  const ids = (await db.select({ id: spotifyTrack.spotifyId }).from(spotifyTrack)).map(
    (row) => row.id,
  );
  console.log(`${await reclassify(ids)} classifications updated.`);
});
