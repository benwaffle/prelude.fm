import assert from 'node:assert/strict';
import test from 'node:test';
import { invariantHealth, type GradedInvariant } from '../app/lib/musicbrainz-invariant-health';

const NOW = new Date('2026-09-21T12:00:00Z');

/** Stands in for the check set; the real one is SQL and needs a database. */
const CHECKS = [
  { name: 'every anchor names a cached recording', severity: 'hard' },
  { name: 'every work part has a parent we hold', severity: 'hard' },
  { name: 'recordings without credits', severity: 'soft' },
];

function recorded(overrides: Partial<GradedInvariant> = {}): GradedInvariant[] {
  return CHECKS.map((check) => ({
    name: check.name,
    severity: check.severity,
    violations: 0,
    checkedAt: new Date('2026-09-21T06:00:00Z'),
    ...overrides,
  }));
}

test('a recent clean sweep is green', () => {
  assert.deepEqual(invariantHealth(CHECKS, recorded(), NOW), {
    failing: [],
    stale: [],
    neverRun: [],
    state: 'green',
  });
});

test('a hard violation is red', () => {
  const results = recorded();
  const hard = results.find((result) => result.severity === 'hard');
  assert.ok(hard);
  hard.violations = 3;

  const health = invariantHealth(CHECKS, results, NOW);
  assert.equal(health.state, 'red');
  assert.deepEqual(health.failing, [hard.name]);
});

test('a soft violation is not a failure', () => {
  const results = recorded();
  const soft = results.find((result) => result.severity !== 'hard');
  if (!soft) return;
  soft.violations = 9;

  assert.equal(invariantHealth(CHECKS, results, NOW).state, 'green');
});

test('an old clean sweep is amber, not green', () => {
  // A page of zeroes from three months ago reads exactly like a page of
  // zeroes from this morning, and that is the failure worth guarding
  // against: silence from a check nobody has run is not a pass.
  const health = invariantHealth(
    CHECKS,
    recorded({ checkedAt: new Date('2026-06-01T00:00:00Z') }),
    NOW,
  );

  assert.equal(health.state, 'amber');
  assert.equal(health.stale.length, CHECKS.length);
  assert.deepEqual(health.failing, []);
});

test('a check nobody has ever run is amber and named', () => {
  const health = invariantHealth(CHECKS, recorded().slice(1), NOW);

  assert.equal(health.state, 'amber');
  assert.deepEqual(health.neverRun, [CHECKS[0].name]);
});

test('a hard failure outranks staleness', () => {
  const results = recorded({ checkedAt: new Date('2026-06-01T00:00:00Z') });
  const hard = results.find((result) => result.severity === 'hard');
  assert.ok(hard);
  hard.violations = 1;

  assert.equal(invariantHealth(CHECKS, results, NOW).state, 'red');
});
