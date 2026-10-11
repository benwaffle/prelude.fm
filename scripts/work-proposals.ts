/**
 * Proposed works for library recordings MusicBrainz links to none.
 *
 *   pnpm metadata:work-proposals                  recordings with no stored proposal
 *   pnpm metadata:work-proposals --refresh        every recording, again
 *   pnpm metadata:work-proposals --release <mbid> one album
 *   pnpm metadata:work-proposals --albums 5       stop after five albums
 *   pnpm metadata:work-proposals --no-store       run without writing anything
 *   pnpm metadata:work-proposals --json
 *
 * Spends MusicBrainz requests on the backfill channel, through the gateway.
 * Writes only `mb_work_proposal` (unless --no-store); submits nothing.
 */
import { loadEnvConfig } from '@next/env';

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main() {
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required (put it in .env.local or export it)');
  }
  const json = process.argv.includes('--json');
  const store = !process.argv.includes('--no-store');
  const refresh = process.argv.includes('--refresh');
  const release = option('--release');
  const albums = option('--albums');

  const run = await import('@/lib/work-proposals-run');
  let gaps = await run.loadProposalGaps();
  if (release) gaps = gaps.filter((gap) => gap.releaseMbid === release);
  if (!refresh) {
    const done = await run.proposedRecordings(gaps.map((gap) => gap.recordingMbid));
    gaps = gaps.filter((gap) => !done.has(gap.recordingMbid));
  }
  let groups = run.groupGaps(gaps);
  if (albums) groups = groups.slice(0, Number(albums));

  const all = [];
  const counts = { high: 0, medium: 0, low: 0, none: 0 };
  let requests = 0;
  for (const [index, group] of groups.entries()) {
    const outcomes = await run.proposeForGroup(group);
    if (store) await run.storeProposals(outcomes);
    for (const outcome of outcomes) {
      counts[outcome.proposal?.confidence ?? 'none']++;
      requests += outcome.requests;
      if (!json) {
        const proposal = outcome.proposal;
        console.log(
          proposal
            ? `${proposal.confidence.padEnd(6)} ${outcome.title}  →  ${proposal.parentTitle ? `${proposal.parentTitle}: ` : ''}${proposal.title}`
            : `none   ${outcome.title}`,
        );
      }
    }
    if (!json) {
      const capped = outcomes.some((outcome) => outcome.familyCapped) ? ' (family capped)' : '';
      console.error(`[${index + 1}/${groups.length}] ${group[0].albumTitle}${capped}`);
    }
    all.push(...outcomes);
  }

  if (json) {
    console.log(JSON.stringify({ stored: store, requests, counts, outcomes: all }, null, 2));
  } else {
    console.log(
      `\n${all.length} recordings: ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.none} with no proposal. ${requests} MusicBrainz requests.${store ? '' : ' Nothing stored.'}`,
    );
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
