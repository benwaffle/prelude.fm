// Usage: pnpm metadata:accounting [--limit N] [--details] [--json]
// Every track asked about must come back exactly once, on a card or in a named gap.
import { defineScript } from './lib/cli';

const BATCH = 500;

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
      import('@/lib/musicbrainz-library-read'),
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
