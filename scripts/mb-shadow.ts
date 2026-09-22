/**
 * Compare legacy and MusicBrainz library projections over the same track IDs.
 *
 * Writes nothing and stores no user membership — IDs come from spotify_track
 * as the held-library proxy, same as metadata:accounting.
 *
 *   pnpm metadata:shadow --json
 *   pnpm metadata:shadow --limit 2000 --details --json
 */
import { loadEnvConfig } from '@next/env';

type Options = { limit: number; json: boolean; details: boolean };

function parseOptions(argv: string[]): Options {
  const options: Options = { limit: Number.POSITIVE_INFINITY, json: false, details: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') options.limit = Number(argv[++i]);
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--details') options.details = true;
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required');
  }

  const [{ db }, schema, legacy, adapter, projection, shadow] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('@/app/actions/library'),
    import('@/app/actions/library-musicbrainz'),
    import('@/lib/musicbrainz-library'),
    import('@/lib/musicbrainz-shadow'),
  ]);

  const trackIds = (
    await db.select({ spotifyId: schema.spotifyTrack.spotifyId }).from(schema.spotifyTrack)
  )
    .map((row) => row.spotifyId)
    .slice(0, Number.isFinite(options.limit) ? options.limit : undefined);

  if (!options.json) process.stderr.write(`Comparing ${trackIds.length} tracks…\n`);

  const [legacyWorks, facts] = await Promise.all([
    legacy.getLibraryWorks(trackIds),
    adapter.loadMusicBrainzLibraryFacts(trackIds),
  ]);
  const comparison = shadow.compareLibraryProjections(
    legacyWorks,
    projection.projectMusicBrainzLibrary(facts),
  );

  const output = {
    requestedTrackCount: comparison.requestedTrackCount,
    legacyHeldCount: comparison.legacyHeldCount,
    musicBrainzHeldCount: comparison.musicBrainzHeldCount,
    readyCount: comparison.readyCount,
    incompleteCount: comparison.incompleteCount,
    gapBucketCount: comparison.gapBucketCount,
    coalescedDuplicateReleaseCount: comparison.coalescedDuplicateReleaseCount,
    differenceCounts: comparison.differenceCounts,
    gates: comparison.gates,
    differences: options.details ? comparison.differences : comparison.differences.slice(0, 50),
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`Requested ${output.requestedTrackCount} tracks`);
    console.log(`Legacy held: ${output.legacyHeldCount}`);
    console.log(`MusicBrainz held: ${output.musicBrainzHeldCount}`);
    console.log(`Ready: ${output.readyCount}, incomplete: ${output.incompleteCount}`);
    console.log('\nDifference counts:');
    for (const [code, count] of Object.entries(output.differenceCounts)) {
      if (count > 0) console.log(`  ${code}: ${count}`);
    }
    console.log('\nGates:');
    console.log(
      `  everyRequestedTrackAccountedFor: ${output.gates.everyRequestedTrackAccountedFor}`,
    );
    console.log(`  noTrackDisappears: ${output.gates.noTrackDisappears}`);
  }

  if (!output.gates.everyRequestedTrackAccountedFor || !output.gates.noTrackDisappears) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
