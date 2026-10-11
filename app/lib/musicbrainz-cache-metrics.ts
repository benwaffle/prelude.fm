/**
 * How the MusicBrainz cache is doing: cache hits and misses per lookup, the
 * requests each operation spends, and the requests each import run caused.
 * Written as the cache works, read by the admin pages.
 */
import { sql } from 'drizzle-orm';
import { db } from './db';
import { mbCacheLookupMetric, mbImportRun, mbRequestOperationMetric } from './db/schema';
import type { MusicBrainzChannel } from './musicbrainz-budget';
import type { MusicBrainzSource } from './musicbrainz-source';
import type { AnonymousImportRunInput } from './track-classification';

export type { AnonymousImportRunInput };

export type MarginalRequestPercentiles = {
  runs: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
};

function metricDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function channelFromSource(source: MusicBrainzSource): MusicBrainzChannel {
  const match = /^musicbrainz-api:(\w+)$/.exec(source.name);
  if (
    match &&
    (['interactive', 'backfill', 'bot'] as const).includes(match[1] as MusicBrainzChannel)
  ) {
    return match[1] as MusicBrainzChannel;
  }
  return 'backfill';
}

export async function bumpCacheLookup(operation: string, hits: number, misses: number) {
  if (hits === 0 && misses === 0) return;
  const day = metricDay();
  const lookups = hits + misses;
  await db
    .insert(mbCacheLookupMetric)
    .values({ day, operation, lookups, hits, misses })
    .onConflictDoUpdate({
      target: [mbCacheLookupMetric.day, mbCacheLookupMetric.operation],
      set: {
        lookups: sql`${mbCacheLookupMetric.lookups} + ${lookups}`,
        hits: sql`${mbCacheLookupMetric.hits} + ${hits}`,
        misses: sql`${mbCacheLookupMetric.misses} + ${misses}`,
      },
    });
}

export async function recordMusicBrainzRequest(
  source: MusicBrainzSource,
  operation: string,
  count = 1,
) {
  if (count <= 0) return;
  const day = metricDay();
  const channel = channelFromSource(source);
  await db
    .insert(mbRequestOperationMetric)
    .values({ day, channel, operation, requests: count })
    .onConflictDoUpdate({
      target: [
        mbRequestOperationMetric.day,
        mbRequestOperationMetric.channel,
        mbRequestOperationMetric.operation,
      ],
      set: {
        requests: sql`${mbRequestOperationMetric.requests} + ${count}`,
      },
    });
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? null;
}

/** Persist one anonymous import/worker pass for marginal-request analysis. */
export async function recordAnonymousImportRun(input: AnonymousImportRunInput): Promise<number> {
  const [row] = await db
    .insert(mbImportRun)
    .values({
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      inputTrackCount: input.inputTrackCount,
      classicalCount: input.classicalCount,
      uncertainCount: input.uncertainCount,
      notClassicalCount: input.notClassicalCount,
      unreviewedCount: input.unreviewedCount,
      albumsAlreadyCached: input.albumsAlreadyCached,
      albumsNew: input.albumsNew,
      requestsCaused: input.requestsCaused,
    })
    .returning({ id: mbImportRun.id });
  return row.id;
}

/** Rolling marginal MusicBrainz requests per import run. */
export async function marginalRequestPercentiles(
  sinceDays = 30,
): Promise<MarginalRequestPercentiles> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const rows = await db
    .select({ requestsCaused: mbImportRun.requestsCaused })
    .from(mbImportRun)
    .where(sql`${mbImportRun.completedAt} >= ${since.getTime()}`)
    .orderBy(mbImportRun.requestsCaused);
  const values = rows.map((row) => row.requestsCaused);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    runs: values.length,
    mean: values.length > 0 ? total / values.length : null,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
  };
}
