import { loadEnvConfig } from '@next/env';

async function main() {
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is required');
  const { runMusicBrainzInvariants, hardViolations } = await import('@/lib/musicbrainz-invariants');
  const results = await runMusicBrainzInvariants({
    sampleSize: process.argv.includes('--details') ? 1000 : 5,
  });
  const broken = hardViolations(results);
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          ok: broken.length === 0,
          musicbrainzInvariants: results.map(({ name, severity, violations, samples }) => ({
            name,
            severity,
            violations,
            samples,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log('MusicBrainz cache invariants');
    console.table(
      results.map(({ name, severity, violations }) => ({
        metric: name,
        value: violations,
        status: severity === 'hard' ? (violations === 0 ? 'PASS' : 'FAIL') : 'INFO',
      })),
    );
    for (const result of results) {
      if (result.samples.length > 0) {
        console.log(`\n${result.name} samples`);
        console.table(result.samples);
      }
    }
  }
  if (broken.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
