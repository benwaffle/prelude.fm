/**
 * The admin Overview's readiness funnel, from the command line.
 *
 * How many library tracks the player can show, and, for the rest, the
 * MusicBrainz edit (or cache read) that would show them. Reads only.
 *
 *   pnpm metadata:readiness          the funnel and its buckets
 *   pnpm metadata:readiness --json   machine-readable
 *
 * Exits non-zero if the funnel does not account for every track exactly
 * once, because that is a fault in the funnel rather than a gap in the data.
 */
import { loadEnvConfig } from '@next/env';

async function main() {
  const json = process.argv.includes('--json');
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required (put it in .env.local or export it)');
  }
  const { loadReadinessFunnel } = await import('@/app/admin/lib/catalogue-readiness-load');
  const funnel = await loadReadinessFunnel();

  const blocked = funnel.steps.reduce((sum, step) => sum + step.blocked, 0);
  const accounted = funnel.notClassical + blocked + funnel.ready;
  if (json) {
    console.log(JSON.stringify({ ...funnel, accounted }, null, 2));
  } else {
    const n = (value: number) => value.toLocaleString('en').padStart(7);
    console.log(`${n(funnel.total)}  tracks in the library`);
    console.log(`${n(funnel.notClassical)}  not classical (excluded)`);
    console.log(`${n(funnel.inScope)}  to make ready`);
    for (const step of funnel.steps) {
      console.log(
        `${n(step.reached)}  ${step.label}  (${step.blocked.toLocaleString('en')} stop here)`,
      );
    }
    console.log(`${n(funnel.ready)}  ready`);
    for (const step of funnel.steps.filter((candidate) => candidate.blocked > 0)) {
      console.log(`\nStopped before "${step.label}":`);
      for (const bucket of step.buckets) {
        const waiting = bucket.waiting > 0 ? `, ${bucket.waiting} submitted and waiting` : '';
        const where = bucket.inboxClass ? ` [Inbox: ${bucket.inboxClass}]` : ` [${bucket.kind}]`;
        console.log(
          `${n(bucket.tracks)}  ${bucket.label} — ${bucket.groups} ${bucket.groupNoun}(s)${waiting}${where}`,
        );
      }
    }
    console.log(
      `\nAccounted for ${accounted.toLocaleString('en')} of ${funnel.total.toLocaleString('en')}`,
    );
  }
  if (accounted !== funnel.total) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
