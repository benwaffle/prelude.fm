// Usage: pnpm metadata:work-proposals [--refresh] [--release <mbid>] [--albums N] [--no-store] [--json]
// Spends backfill-channel requests; writes only `mb_work_proposal`. Submits nothing.
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
