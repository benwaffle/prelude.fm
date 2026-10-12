import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let worksNeedingDetail: typeof import('../app/lib/musicbrainz-cache').worksNeedingDetail;
let releaseIsCached: typeof import('../app/lib/musicbrainz-cache').releaseIsCached;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ worksNeedingDetail, releaseIsCached } = await import('../app/lib/musicbrainz-cache'));
});

beforeEach(async () => {
  await resetTestDatabase(db);
});

test('worksNeedingDetail returns works not read in full', async () => {
  await db.insert(schema.mbWork).values([
    { mbid: 'work-full', title: 'Full', detail: 'full' },
    { mbid: 'work-stub', title: 'Stub', detail: 'stub' },
  ]);

  const pending = await worksNeedingDetail(['work-full', 'work-stub', 'work-absent']);
  assert.deepEqual(pending.sort(), ['work-absent', 'work-stub']);
});

test('releaseIsCached reflects mb_release membership', async () => {
  await db.insert(schema.mbRelease).values({ mbid: 'release-1', title: 'Album' });
  assert.equal(await releaseIsCached('release-1'), true);
  assert.equal(await releaseIsCached('release-missing'), false);
});
