import type { Sweep, SweepResult } from '@/lib/backfill-sweep';

export const SWEEP_OPTIONS = {
  refresh: { type: 'boolean' },
  albums: { type: 'integer', min: 1 },
  'no-store': { type: 'boolean' },
  json: { type: 'boolean' },
} as const;

type SweepFlags = { albums: number | undefined; 'no-store': boolean; json: boolean };

export async function runSweepCli<G, O extends { requests: number }, K extends string>(
  flags: SweepFlags,
  sweep: Omit<Sweep<G, O, K>, 'store' | 'onGroup'> & {
    store: (outcomes: O[]) => Promise<void>;
    line: (outcome: O) => string;
    label: (group: G[], outcomes: O[]) => string;
    summary: (result: SweepResult<O, K>) => string;
    extra?: () => Record<string, unknown>;
  },
): Promise<void> {
  const { runSweep } = await import('@/lib/backfill-sweep');
  const stored = !flags['no-store'];
  const groups = flags.albums === undefined ? sweep.groups : sweep.groups.slice(0, flags.albums);
  const result = await runSweep({
    ...sweep,
    groups,
    store: stored ? sweep.store : null,
    onGroup: (group, outcomes, index) => {
      if (flags.json) return;
      for (const outcome of outcomes) console.log(sweep.line(outcome));
      console.error(`[${index + 1}/${groups.length}] ${sweep.label(group, outcomes)}`);
    },
  });
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          stored,
          requests: result.requests,
          counts: result.counts,
          ...sweep.extra?.(),
          outcomes: result.outcomes,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `\n${sweep.summary(result)} ${result.requests} MusicBrainz requests.${stored ? '' : ' Nothing stored.'}`,
    );
  }
}
