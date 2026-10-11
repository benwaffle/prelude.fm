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
import { defineScript } from './lib/cli';
import { runSweepCli, SWEEP_OPTIONS } from './lib/sweep-cli';

defineScript(
  { options: { ...SWEEP_OPTIONS, release: { type: 'string' } } },
  async ({ options }) => {
    const [run, { groupBy, unstored }, { mbWorkProposal }] = await Promise.all([
      import('@/lib/work-proposals-run'),
      import('@/lib/backfill-sweep'),
      import('@/lib/db/schema'),
    ]);
    let gaps = await run.loadProposalGaps();
    if (options.release) gaps = gaps.filter((gap) => gap.releaseMbid === options.release);
    if (!options.refresh) {
      gaps = await unstored(
        gaps,
        (gap) => gap.recordingMbid,
        mbWorkProposal,
        mbWorkProposal.recordingMbid,
      );
    }

    await runSweepCli(options, {
      groups: groupBy(gaps, run.proposalGroupKey),
      process: run.proposeForGroup,
      store: run.storeProposals,
      buckets: ['high', 'medium', 'low', 'none'] as const,
      tally: (outcome) => outcome.proposal?.confidence ?? 'none',
      line: ({ proposal, title }) =>
        proposal
          ? `${proposal.confidence.padEnd(6)} ${title}  →  ${proposal.parentTitle ? `${proposal.parentTitle}: ` : ''}${proposal.title}`
          : `none   ${title}`,
      label: (group, outcomes) =>
        `${group[0].albumTitle}${outcomes.some((outcome) => outcome.familyCapped) ? ' (family capped)' : ''}`,
      summary: ({ outcomes, counts }) =>
        `${outcomes.length} recordings: ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.none} with no proposal.`,
    });
  },
);
