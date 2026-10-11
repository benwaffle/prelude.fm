/**
 * What the MusicBrainz reader can account for, and what it cannot.
 *
 * The cutover has one hard rule — no track disappears — and one contract:
 * every track asked about comes back exactly once, either on a card or in a
 * named gap. This measures both against the real database, in bounded
 * batches, and writes nothing.
 *
 *   pnpm metadata:accounting                 every Spotify track we hold
 *   pnpm metadata:accounting --limit 2000    the first n, for a quick read
 *   pnpm metadata:accounting --details       every affected track ID, not a sample
 *   pnpm metadata:accounting --json          machine-readable, for a deploy log
 *
 * Exits non-zero when a requested ID comes back unaccounted for, because
 * that is a fault in the reader rather than a gap in MusicBrainz.
 */
import { defineScript } from './lib/cli';

/** Small enough that one batch is one modest set of queries. */
const BATCH = 500;

/** How many IDs to name per finding when not printing all of them. */
const SAMPLE = 5;

defineScript(
  {
    options: {
      limit: { type: 'integer', min: 1 },
      details: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  },
  async ({ options }) => {
    const [{ db }, schema, adapter, projection] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/db/schema'),
      import('@/app/actions/library-musicbrainz'),
      import('@/lib/musicbrainz-library'),
    ]);

    const trackIds = (
      await db.select({ spotifyId: schema.spotifyTrack.spotifyId }).from(schema.spotifyTrack)
    )
      .map((row) => row.spotifyId)
      .slice(0, options.limit);

    const statuses = new Map<string, number>();
    const gapCodes = new Map<string, string[]>();
    const unaccounted: string[] = [];
    let ready = 0;

    for (let start = 0; start < trackIds.length; start += BATCH) {
      const batch = trackIds.slice(start, start + BATCH);
      const result = projection.projectMusicBrainzLibrary(
        await adapter.loadMusicBrainzLibraryFacts(batch),
      );
      const accounted = new Set(result.accounting.map((track) => track.spotifyTrackId));
      for (const trackId of batch) if (!accounted.has(trackId)) unaccounted.push(trackId);

      for (const track of result.accounting) {
        statuses.set(track.status, (statuses.get(track.status) ?? 0) + 1);
        if (track.status === 'ready') ready++;
        for (const code of track.gapCodes) {
          gapCodes.set(code, [...(gapCodes.get(code) ?? []), track.spotifyTrackId]);
        }
      }
      if (!options.json) {
        process.stderr.write(`\r${Math.min(start + BATCH, trackIds.length)}/${trackIds.length}`);
      }
    }
    // End the progress line so the report does not start on top of it.
    if (!options.json) process.stderr.write('\n');

    const gaps = [...gapCodes]
      .sort((left, right) => right[1].length - left[1].length)
      .map(([code, ids]) => ({
        code,
        tracks: ids.length,
        trackIds: options.details ? ids : ids.slice(0, SAMPLE),
      }));
    const summary = {
      requested: trackIds.length,
      ready,
      byStatus: Object.fromEntries([...statuses].sort()),
      gaps,
      unaccounted,
      gates: { everyRequestedTrackAccountedFor: unaccounted.length === 0 },
    };

    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`Requested ${summary.requested} tracks`);
      for (const [status, count] of [...statuses].sort()) console.log(`  ${status}: ${count}`);
      console.log('\nGaps, most common first:');
      for (const gap of gaps) {
        console.log(`  ${gap.tracks.toString().padStart(6)}  ${gap.code}`);
        console.log(
          `          ${gap.trackIds.join(', ')}${gap.tracks > gap.trackIds.length ? ', …' : ''}`,
        );
      }
      if (unaccounted.length > 0) {
        console.log(`\nUNACCOUNTED (a fault, not a gap): ${unaccounted.length}`);
        console.log(`  ${unaccounted.slice(0, SAMPLE).join(', ')}`);
      }
    }

    return unaccounted.length > 0 ? 1 : 0;
  },
);
