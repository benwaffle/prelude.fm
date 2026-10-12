import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import {
  ALBUM_ROW,
  artist,
  fakeSource,
  providerTrackRows,
  readAlbum,
  release,
  workTree,
} from './helpers/musicbrainz-fixtures';
import type { AlbumPassDependencies } from '../app/lib/match-queue-processor';

// A track MusicBrainz says nothing about must not read as a failure, be picked up again, or reach
// the LLM.

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let processor: typeof import('@/lib/match-queue-processor');

const OWNER = 'worker-1';

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  processor = await import('@/lib/match-queue-processor');
});

beforeEach(async () => {
  await resetTestDatabase(db);
  await db.insert(schema.spotifyAlbum).values(ALBUM_ROW);
  await db.insert(schema.matchQueue).values(
    ['track-1', 'track-2'].map((spotifyId) => ({
      spotifyId,
      spotifyAlbumId: 'album-1',
      submittedBy: 'test',
      status: 'processing' as const,
      attempts: 1,
      lastAttemptAt: new Date('2026-09-21T00:00:00Z'),
      claimOwnerId: OWNER,
    })),
  );
});

async function seedProviderTracks() {
  await db.insert(schema.spotifyTrack).values(providerTrackRows());
}

function runPass(dependencies: AlbumPassDependencies) {
  return processor.processQueuedAlbum('album-1', OWNER, ['track-1', 'track-2'], dependencies);
}

async function queueRows() {
  return (await db.select().from(schema.matchQueue)).sort((left, right) =>
    left.spotifyId.localeCompare(right.spotifyId),
  );
}

test('a track MusicBrainz places and calls classical is matched', async () => {
  const result = await runPass({
    readAlbum,
    musicBrainzSource: fakeSource({
      releasesByBarcode: async () => ['release-1'],
      releaseWithRecordings: async () => release({ works: true }),
      work: async (id) => workTree(id),
      artist,
    }),
  });

  assert.equal(result.matched, 2);
  assert.equal(result.musicbrainz?.releaseCached, true);
  assert.equal(result.musicbrainz?.alreadyCached, false);
  assert.equal(result.musicbrainz?.anchored, 2);
  assert.ok((result.musicbrainz?.requests ?? 0) > 0);
  assert.equal(result.unresolved, 0);
  assert.equal(result.failed, 0);
  for (const row of await queueRows()) {
    assert.equal(row.status, 'matched');
    assert.equal(row.pipelineOutcome, 'ready');
    assert.ok(row.pipelineReason, 'the reader is told why this counts as classical');
  }
});

test('a track no MusicBrainz recording matches is unresolved, not failed', async () => {
  const result = await runPass({
    readAlbum,
    musicBrainzSource: fakeSource({
      releasesByBarcode: async () => [],
      searchReleases: async () => [],
    }),
  });

  assert.equal(result.unresolved, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.matched, 0);
  assert.deepEqual(result.errors, [], 'a gap in MusicBrainz is not an error of ours');
  for (const row of await queueRows()) {
    assert.equal(row.status, 'unresolved');
    assert.equal(row.pipelineOutcome, 'unanchored');
    assert.match(row.pipelineReason ?? '', /MusicBrainz/);
    assert.equal(row.errorMessage, null);
    assert.equal(row.claimOwnerId, null, 'the claim is released');
    assert.ok(row.pipelineCompletedAt, 'the pass says when it finished');
  }
});

test('a track MusicBrainz places but does not settle is unresolved', async () => {
  const result = await runPass({
    readAlbum,
    musicBrainzSource: fakeSource({
      releasesByBarcode: async () => ['release-1'],
      releaseWithRecordings: async () => release({ works: false }),
      artist,
    }),
  });

  assert.equal(result.unresolved, 2);
  assert.equal(result.failed, 0);
  for (const row of await queueRows()) {
    assert.equal(row.status, 'unresolved');
    assert.equal(row.pipelineOutcome, 'unclassified');
    assert.equal(row.errorMessage, null);
    assert.equal(row.claimOwnerId, null);
  }
  const classifications = await db.select().from(schema.trackClassification);
  assert.deepEqual(
    classifications.map((row) => row.state).sort(),
    ['unreviewed', 'unreviewed'],
    'nothing is asserted about a track MusicBrainz did not settle',
  );
});

test('a track already ruled non-classical keeps that status', async () => {
  await seedProviderTracks();
  // MusicBrainz finds no evidence to overturn the parser's verdict, so the pass must not reopen it.
  await db
    .update(schema.matchQueue)
    .set({ status: 'not_classical' })
    .where(eq(schema.matchQueue.spotifyId, 'track-1'));

  const result = await runPass({
    readAlbum,
    musicBrainzSource: fakeSource({
      releasesByBarcode: async () => ['release-1'],
      releaseWithRecordings: async () => release({ works: false }),
      artist,
    }),
  });

  assert.equal(result.notClassical, 1);
  assert.equal(result.unresolved, 1);
  const rows = await queueRows();
  assert.equal(rows[0].status, 'not_classical');
  assert.equal(rows[0].pipelineOutcome, 'not_classical');
  assert.equal(rows[1].status, 'unresolved');
  assert.equal(rows[1].pipelineOutcome, 'unclassified');

  const [classification] = await db
    .select()
    .from(schema.trackClassification)
    .where(eq(schema.trackClassification.spotifyTrackId, 'track-1'));
  assert.equal(classification.state, 'not_classical');
  assert.equal(
    classification.provenance,
    'llm_proposal',
    'a parser verdict is labelled the proposal it is, not promoted by the pass',
  );
});

test('an unresolved track is not reclaimed on the next cron tick', async () => {
  await runPass({
    readAlbum,
    musicBrainzSource: fakeSource({
      releasesByBarcode: async () => [],
      searchReleases: async () => [],
    }),
  });

  // What the cron's GET does before it schedules a worker.
  const prepared = await processor.prepareMatchQueue({
    maxAttempts: 5,
    retryFailed: true,
    staleMinutes: 30,
  });
  assert.deepEqual(prepared, { recovered: 0, retried: 0, exhausted: 0 });

  for (const row of await queueRows()) {
    assert.equal(row.status, 'unresolved');
    assert.equal(row.attempts, 1, 'no attempt is spent re-asking the same question');
  }
  assert.equal(
    await processor.claimNextPendingAlbum('worker-2', 5),
    null,
    'there is nothing left for a worker to claim',
  );
});
