import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import type { SeedPlan } from '../app/lib/release-seeding';
import type { ReleaseCorrectionRecord } from '../app/lib/release-corrections';
import type { WorkProposal } from '../app/lib/work-proposals';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let store: typeof import('@/lib/missing-release-store');
let seeds: typeof import('@/lib/release-seeding-run');
let invariants: typeof import('@/lib/musicbrainz-invariants');
let proposals: typeof import('@/lib/work-proposals-run');

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  store = await import('@/lib/missing-release-store');
  seeds = await import('@/lib/release-seeding-run');
  invariants = await import('@/lib/musicbrainz-invariants');
  proposals = await import('@/lib/work-proposals-run');
});

beforeEach(async () => {
  await resetTestDatabase(db);
  await db.insert(schema.spotifyAlbum).values([
    { spotifyId: 'album-1', title: 'First' },
    { spotifyId: 'album-2', title: 'Second' },
  ]);
});

const plan = (title: string) => ({ title, tracks: [], notes: [] }) as unknown as SeedPlan;
const correction = (releaseMbid: string) => ({ releaseMbid }) as unknown as ReleaseCorrectionRecord;

test('a seed opened on MusicBrainz is kept when the seed is prepared again', async () => {
  await store.writeMissingRelease('album-1', 'seed', plan('opened'), 4);
  await store.markReleaseSeeded('album-1');
  await store.writeMissingRelease('album-1', 'seed', plan('prepared again'), 2);

  const seed = (await seeds.cachedReleaseSeeds(['album-1'])).get('album-1');
  assert.equal(seed?.plan.title, 'prepared again');
  assert.equal(seed?.requests, 2);
  assert.equal(seed?.seededPlan?.title, 'opened');
  assert.ok(seed?.seededAt instanceof Date);
});

test('a seed never opened has no seeded plan, and albums without a seed are absent', async () => {
  await store.writeMissingRelease('album-1', 'seed', plan('only prepared'), 1);
  await store.markReleaseSeeded('album-2');
  const stored = await seeds.cachedReleaseSeeds(['album-1', 'album-2']);
  assert.deepEqual([...stored.keys()], ['album-1']);
  assert.equal(stored.get('album-1')?.seededAt, null);
  assert.equal(stored.get('album-1')?.seededPlan, null);
});

test('stages are read together and corrections list newest first with titles', async () => {
  await store.writeMissingRelease('album-1', 'correction', correction('older'), 3);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.writeMissingRelease('album-2', 'correction', correction('newer'), 5);
  await store.writeMissingRelease('album-1', 'seed', plan('a seed'), 1);

  const both = await store.readMissingReleases(['album-1', 'album-2']);
  assert.deepEqual(Object.keys(both.get('album-1') ?? {}).sort(), ['correction', 'seed']);
  assert.deepEqual(Object.keys(both.get('album-2') ?? {}), ['correction']);

  const rows = await store.correctionRecords();
  assert.deepEqual(
    rows.map((row) => [row.albumTitle, row.record.releaseMbid]),
    [
      ['Second', 'newer'],
      ['First', 'older'],
    ],
  );
});

test('invariants count every violation but read only a sample', async () => {
  await db.insert(schema.mbWork).values(
    ['a', 'b', 'c'].map((mbid) => ({
      mbid,
      title: mbid,
      parentMbid: `missing-${mbid}`,
      detail: 'full' as const,
    })),
  );
  const results = await invariants.runMusicBrainzInvariants({ sampleSize: 2 });
  const parent = results.find((result) => result.name === 'work-parent-is-cached');
  assert.equal(parent?.violations, 3);
  assert.equal(parent?.samples.length, 2);
  assert.equal(results.find((result) => result.name === 'work-tree-has-no-cycle')?.violations, 0);

  await invariants.recordInvariantResults(results);
  await invariants.recordInvariantResults(results);
  const stored = await invariants.latestInvariantResults();
  assert.equal(stored.length, results.length);
  assert.equal(stored.find((result) => result.name === 'work-parent-is-cached')?.violations, 3);
});

function outcome(recordingMbid: string, workMbid: string | null) {
  return {
    recordingMbid,
    title: recordingMbid,
    albumTitle: 'First',
    releaseMbid: 'release-1',
    proposal: workMbid ? ({ workMbid } as unknown as WorkProposal) : null,
    requests: 1,
    familyCapped: false,
  };
}

test('a stored decision survives a re-run proposing the same work, not a different one', async () => {
  await proposals.storeProposals([outcome('same', 'work-1'), outcome('changed', 'work-1')]);
  await db.update(schema.mbWorkProposal).set({ status: 'approved', decidedAt: new Date() });
  await proposals.storeProposals([
    outcome('same', 'work-1'),
    outcome('changed', 'work-2'),
    outcome('none', null),
  ]);

  const rows = await db.select().from(schema.mbWorkProposal);
  const by = new Map(rows.map((row) => [row.recordingMbid, row]));
  assert.equal(by.get('same')?.status, 'approved');
  assert.ok(by.get('same')?.decidedAt);
  assert.equal(by.get('changed')?.status, 'proposed');
  assert.equal(by.get('changed')?.decidedAt, null);
  assert.equal(by.get('changed')?.workMbid, 'work-2');
  assert.equal(by.get('none')?.workMbid, null);
});
