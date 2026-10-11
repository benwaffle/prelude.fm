import { defineScript } from './lib/cli';

defineScript(
  { options: { details: { type: 'boolean' }, json: { type: 'boolean' } } },
  async ({ options }) => {
    const { runMusicBrainzInvariants, hardViolations } =
      await import('@/lib/musicbrainz-invariants');
    const results = await runMusicBrainzInvariants({ sampleSize: options.details ? 1000 : 5 });
    const broken = hardViolations(results);
    if (options.json) {
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
    return broken.length > 0 ? 1 : 0;
  },
);
