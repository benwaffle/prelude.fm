/**
 * Reading a set of recorded invariant results as a health state.
 *
 * Kept apart from the checks themselves — which are SQL, and so drag in a
 * database connection — because the grading rule is the part worth arguing
 * about and it should be testable without one.
 */

export type InvariantSeverityLike = 'hard' | string;

export type GradedInvariant = {
  name: string;
  severity: InvariantSeverityLike;
  violations: number;
  /** When the result was recorded. Null or absent means never run. */
  checkedAt?: Date | null;
};

/**
 * How long a recorded result stands for before it stops being evidence.
 *
 * A clean invariant page is only reassuring if it is recent. Left alone, a
 * page of zeroes from three months ago reads exactly like a page of zeroes
 * from this morning, which is the failure mode worth guarding against.
 */
export const INVARIANT_STALE_AFTER_HOURS = 36;

export type InvariantHealth = {
  /** Hard checks currently failing. Anything here means stop. */
  failing: string[];
  /** Checks whose last result is older than the window. */
  stale: string[];
  /** Checks that have never run, so their silence means nothing. */
  neverRun: string[];
  state: 'green' | 'amber' | 'red';
};

/**
 * Grades `results` against the checks that were supposed to run.
 *
 * Red for a hard failure. Amber for evidence that is missing or out of date
 * — not a failure, but not a pass either, and the page should not be green
 * on the strength of a check nobody has run.
 */
export function invariantHealth(
  expected: Array<{ name: string; severity: InvariantSeverityLike }>,
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
    if (check.severity === 'hard' && result.violations > 0) failing.push(check.name);
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
