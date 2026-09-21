/**
 * Run prelude_fm_bot's ISRC submissions.
 *
 *   pnpm mb:bot                    show what would be submitted
 *   pnpm mb:bot --apply            submit it
 *   pnpm mb:bot --max-edits 10     smaller batch
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
  const showPayload = process.argv.includes('--payload');

  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is required');

  const { runIsrcBot } = await import('@/lib/musicbrainz-bot');
  const run = await runIsrcBot({ apply, maxEdits });

  console.log(apply && run.submitted ? 'Submitted.' : 'Dry run. Pass --apply to submit.');
  console.log(`
  edits in this batch     ${run.edits}
  edits already today     ${run.spentToday} of 1000
  recordings addressed    ${new Set(run.items.map((i) => i.recordingMbid)).size}`);

  console.log(`\n  edit note:\n    ${run.editNote}`);

  if (run.items.length > 0) {
    console.log('\n  first few:');
    for (const item of run.items.slice(0, 8)) {
      console.log(`    ${item.isrc}  ->  ${item.recordingMbid}`);
    }
    console.log(
      `\n  verify a sample: https://musicbrainz.org/recording/${run.items[0].recordingMbid}`,
    );
  }

  if (showPayload) console.log(`\n${run.payload}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
