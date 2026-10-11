/**
 * Re-derive every library track's stored classification, after the classical
 * rule changes. Hand decisions are never replaced.
 *
 *   pnpm metadata:reclassify
 *
 * Reads only the database; writes `track_classification`.
 */
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
