/** Kept apart from the SQL checks so the grading rule is testable without a database. */

// `hard`: our cache contradicts itself (our bug, fails). `upstream`: MusicBrainz contradicts itself
// (reported). `review`: evidence points two ways; somebody has to look.
export type InvariantSeverity = 'hard' | 'upstream' | 'review';

export type GradedInvariant = {
  name: string;
  severity: InvariantSeverity;
  violations: number;
  checkedAt?: Date | null;
  /** Found so far by the sweep's pass in progress; a hard one fails before the pass ends. */
  sweepViolations?: number | null;
};

// The daily sweep reads 1/SWEEP_PASS_DAYS of each check's table, so a full pass over the cache
// takes this many days: reading all of it daily would be ~50M rows a day once the dump is in.
export const SWEEP_PASS_DAYS = 28;

// A check is stale once its last full pass is older than a pass plus two missed days. A page of
// zeroes from three months ago would read like one from this morning; one from a month ago is what
// the sweep's budget buys, and the page says so.
export const INVARIANT_STALE_AFTER_HOURS = (SWEEP_PASS_DAYS + 2) * 24;

export type InvariantHealth = {
  failing: string[];
  stale: string[];
  /** Checks that have never run, so their silence means nothing. */
  neverRun: string[];
  state: 'green' | 'amber' | 'red';
};

/** Amber for missing or stale evidence: the page should not be green on a check nobody has run. */
export function invariantHealth(
  expected: Array<{ name: string; severity: InvariantSeverity }>,
  results: GradedInvariant[],
  now: Date = new Date(),
  staleAfterHours: number = INVARIANT_STALE_AFTER_HOURS,
): InvariantHealth {
  const byName = new Map(results.map((result) => [result.name, result]));
  const failing: string[] = [];
  const stale: string[] = [];
  const neverRun: string[] = [];

  for (const check of expected) {
    const result = byName.get(check.name);
    if (!result || !result.checkedAt) {
      neverRun.push(check.name);
      continue;
    }
    if (check.severity === 'hard' && (result.violations > 0 || (result.sweepViolations ?? 0) > 0))
      failing.push(check.name);
    if ((now.getTime() - result.checkedAt.getTime()) / 3_600_000 > staleAfterHours) {
      stale.push(check.name);
    }
  }

  return {
    failing,
    stale,
    neverRun,
    state: failing.length > 0 ? 'red' : stale.length + neverRun.length > 0 ? 'amber' : 'green',
  };
}
