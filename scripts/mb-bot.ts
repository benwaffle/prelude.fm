/**
 * Run prelude_fm_bot's ISRC submissions.
 *
 *   pnpm mb:bot                    show what would be submitted
 *   pnpm mb:bot --apply            submit it
 *   pnpm mb:bot --release <mbid>   a particular release rather than the first
 *
 * One album at a time: an album is the unit somebody can actually check,
 * since every row shares a release, a barcode and one tracklist.
 *
 * Dry run by default, and the dry run needs no credentials, so the payload
 * can be read and a sample hand-checked on musicbrainz.org before anything
 * is sent.
 */
import { loadEnvConfig } from '@next/env';

async function main() {
  const apply = process.argv.includes('--apply');
  const maxIndex = process.argv.indexOf('--max-edits');
  const maxEdits = maxIndex === -1 ? undefined : Number(process.argv[maxIndex + 1]);
  const releaseIndex = process.argv.indexOf('--release');
  const releaseMbid = releaseIndex === -1 ? undefined : process.argv[releaseIndex + 1];
  const showPayload = process.argv.includes('--payload');

  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is required');

  const { runIsrcBot } = await import('@/lib/musicbrainz-bot');
  const run = await runIsrcBot({ apply, maxEdits, releaseMbid });

  console.log(apply && run.submitted ? 'Submitted.' : 'Dry run. Pass --apply to submit.');
  console.log(`
  album                   ${run.albumTitle ?? '(none outstanding)'}
  edits in this batch     ${run.edits}
  edits already today     ${run.spentToday} of 1000
  recordings addressed    ${new Set(run.items.map((i) => i.recordingMbid)).size}`);

  console.log(`\n  edit note:\n    ${run.editNote}`);

  if (run.evidence.length > 0) {
    const strip = (value: string | null) => (value ?? '').replace(/^0+/, '');
    console.log('\n  what would be submitted:');
    for (const gap of run.evidence.slice(0, 8)) {
      const agree = strip(gap.upc) !== '' && strip(gap.upc) === strip(gap.barcode);
      console.log(
        `    ${gap.medium}-${String(gap.position).padEnd(3)} ${gap.isrc}  ${gap.durationDeltaMs}ms  ${agree ? 'barcode ok' : 'BARCODE MISMATCH'}`,
      );
      console.log(`         ours: ${gap.trackTitle}`);
      console.log(`         them: ${gap.recordingTitle}`);
    }
    console.log(
      `\n  verify a sample: https://musicbrainz.org/recording/${run.evidence[0].recordingMbid}`,
    );
  }

  if (showPayload) console.log(`\n${run.payload}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
