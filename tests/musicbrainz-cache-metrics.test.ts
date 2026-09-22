import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let worksNeedingDetail: typeof import('../app/lib/musicbrainz-cache').worksNeedingDetail;
let releaseIsCached: typeof import('../app/lib/musicbrainz-cache').releaseIsCached;
let recordAnonymousImportRun: typeof import('../app/lib/musicbrainz-cache').recordAnonymousImportRun;
let marginalRequestPercentiles: typeof import('../app/lib/musicbrainz-cache').marginalRequestPercentiles;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ worksNeedingDetail, releaseIsCached, recordAnonymousImportRun, marginalRequestPercentiles } =
    await import('../app/lib/musicbrainz-cache'));
});

beforeEach(async () => {
  await resetTestDatabase(db);
});

test('worksNeedingDetail records cache hits and misses', async () => {
  await db.insert(schema.mbWork).values([
    { mbid: 'work-full', title: 'Full', detail: 'full' },
    { mbid: 'work-stub', title: 'Stub', detail: 'stub' },
  ]);

  const pending = await worksNeedingDetail(['work-full', 'work-stub', 'work-absent']);
  assert.deepEqual(pending.sort(), ['work-absent', 'work-stub']);

  const [row] = await db.select().from(schema.mbCacheLookupMetric);
  assert.equal(row?.operation, 'work');
  assert.equal(row?.lookups, 3);
  assert.equal(row?.hits, 1);
  assert.equal(row?.misses, 2);
});

test('releaseIsCached reflects mb_release membership', async () => {
  await db.insert(schema.mbRelease).values({ mbid: 'release-1', title: 'Album' });
  assert.equal(await releaseIsCached('release-1'), true);
  assert.equal(await releaseIsCached('release-missing'), false);
});

test('recordAnonymousImportRun persists anonymous aggregates', async () => {
  const startedAt = new Date('2026-09-22T00:00:00.000Z');
  const completedAt = new Date('2026-09-22T00:01:00.000Z');
  await recordAnonymousImportRun({
    startedAt,
    completedAt,
    inputTrackCount: 12,
    classicalCount: 4,
    uncertainCount: 3,
    notClassicalCount: 1,
    unreviewedCount: 4,
    albumsAlreadyCached: 1,
    albumsNew: 2,
    requestsCaused: 17,
  });

  const [row] = await db.select().from(schema.mbImportRun);
  assert.equal(row?.inputTrackCount, 12);
  assert.equal(row?.requestsCaused, 17);
  assert.equal(row?.albumsAlreadyCached, 1);
});

test('marginalRequestPercentiles computes rolling percentiles', async () => {
  for (const requestsCaused of [5, 10, 20, 40, 100]) {
    await db.insert(schema.mbImportRun).values({
      startedAt: new Date(),
      completedAt: new Date(),
      inputTrackCount: 1,
      classicalCount: 0,
      uncertainCount: 0,
      notClassicalCount: 0,
      unreviewedCount: 1,
      albumsAlreadyCached: 0,
      albumsNew: 1,
      requestsCaused,
    });
  }

  const stats = await marginalRequestPercentiles(30);
  assert.equal(stats.runs, 5);
  assert.equal(stats.p50, 20);
  assert.equal(stats.p90, 100);
  assert.equal(stats.mean, 35);
});

test('request operation metrics can be read by day and channel', async () => {
  const day = new Date().toISOString().slice(0, 10);
  await db.insert(schema.mbRequestOperationMetric).values({
    day,
    channel: 'interactive',
    operation: 'release',
    requests: 3,
  });

  const [row] = await db
    .select()
    .from(schema.mbRequestOperationMetric)
    .where(eq(schema.mbRequestOperationMetric.operation, 'release'));
  assert.equal(row?.requests, 3);
});
