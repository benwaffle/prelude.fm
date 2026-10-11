/**
 * The loop shared by the backfill sweeps (work proposals, track-work links):
 * walk the gaps a group at a time — an album, usually, so what one track
 * finds helps the next — and store each group's outcomes as it finishes, so
 * an interrupted sweep keeps what it did.
 */
import { inArray } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { db } from './db';

/** Rows bound per `in (...)` query. */
const KEY_CHUNK = 400;

/** Items grouped by key, groups in first-seen order. */
export function groupBy<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(key(item));
    if (list) list.push(item);
    else groups.set(key(item), [item]);
  }
  return [...groups.values()];
}

/** The gaps whose key has no row in `column` yet: not checked by an earlier sweep. */
export async function unstored<G>(
  gaps: G[],
  key: (gap: G) => string,
  table: SQLiteTable,
  column: SQLiteColumn,
): Promise<G[]> {
  const keys = gaps.map(key);
  const stored = new Set<string>();
  for (let start = 0; start < keys.length; start += KEY_CHUNK) {
    const rows = await db
      .select({ key: column })
      .from(table)
      .where(inArray(column, keys.slice(start, start + KEY_CHUNK)));
    for (const row of rows) stored.add(row.key as string);
  }
  return gaps.filter((gap) => !stored.has(key(gap)));
}

export type Sweep<G, O extends { requests: number }, K extends string> = {
  groups: G[][];
  process: (group: G[]) => Promise<O[]>;
  /** Writes one group's outcomes; null runs without storing anything. */
  store: ((outcomes: O[]) => Promise<void>) | null;
  /** The summary bucket an outcome counts under. */
  tally: (outcome: O) => K;
  /** Every bucket, in the order the summary lists them. */
  buckets: readonly K[];
  /** Called after each group is processed and stored. */
  onGroup: (group: G[], outcomes: O[], index: number) => void;
};

export type SweepResult<O, K extends string> = {
  outcomes: O[];
  counts: Record<K, number>;
  requests: number;
};

export async function runSweep<G, O extends { requests: number }, K extends string>(
  sweep: Sweep<G, O, K>,
): Promise<SweepResult<O, K>> {
  const outcomes: O[] = [];
  const counts = Object.fromEntries(sweep.buckets.map((bucket) => [bucket, 0])) as Record<
    K,
    number
  >;
  let requests = 0;
  for (const [index, group] of sweep.groups.entries()) {
    const done = await sweep.process(group);
    if (sweep.store) await sweep.store(done);
    for (const outcome of done) {
      counts[sweep.tally(outcome)]++;
      requests += outcome.requests;
    }
    sweep.onGroup(group, done, index);
    outcomes.push(...done);
  }
  return { outcomes, counts, requests };
}
