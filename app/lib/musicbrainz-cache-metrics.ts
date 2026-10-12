import { sql } from 'drizzle-orm';
import { db } from './db';
import { mbCacheLookupMetric, mbImportRun, mbRequestOperationMetric } from './db/schema';
import type { MusicBrainzChannel } from './musicbrainz-budget';
import type { MusicBrainzSource } from './musicbrainz-source';
import type { AnonymousImportRunInput } from './track-classification';

export type { AnonymousImportRunInput };

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
