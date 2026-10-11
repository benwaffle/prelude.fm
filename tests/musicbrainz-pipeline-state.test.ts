import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import type { PersistedTrackPassOutcome } from '../app/lib/musicbrainz-pipeline-state';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let recordAlbumPassOutcomes: typeof import('@/lib/musicbrainz-pipeline-state').recordAlbumPassOutcomes;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ recordAlbumPassOutcomes } = await import('@/lib/musicbrainz-pipeline-state'));
});

beforeEach(async () => {
  await resetTestDatabase(db);
  await db.insert(schema.spotifyAlbum).values({ spotifyId: 'album-1', title: 'An album' });
  await db.insert(schema.spotifyTrack).values(
    ['manual', 'upgrade', 'parser'].map((id, index) => ({
      spotifyId: id,
      title: id,
      trackNumber: index + 1,
      discNumber: 1,
      durationMs: 100_000,
      spotifyAlbumId: 'album-1',
    })),
  );
  await db.insert(schema.matchQueue).values(
    ['manual', 'upgrade', 'parser'].map((spotifyId) => ({
      spotifyId,
      spotifyAlbumId: 'album-1',
      submittedBy: 'test',
      status: 'processing' as const,
      claimOwnerId: 'worker-1',
    })),
  );
  await db.insert(schema.trackClassification).values([
    {
      spotifyTrackId: 'manual',
      state: 'not_classical',
      provenance: 'manual',
      reason: 'reviewed by hand',
      evidenceMbid: null,
      decidedAt: new Date('2026-09-20T00:00:00Z'),
    },
    {
      spotifyTrackId: 'upgrade',
      state: 'not_classical',
      provenance: 'llm_proposal',
      reason: 'parser proposal',
      evidenceMbid: null,
      decidedAt: new Date('2026-09-20T00:00:00Z'),
    },
  ]);
});

test('stores outcome, queue status and classification together, under provenance precedence', async () => {
  const completedAt = new Date('2026-09-21T12:00:00Z');
  const outcomes: PersistedTrackPassOutcome[] = [
    {
      spotifyTrackId: 'manual',
      state: 'ready',
      classification: 'classical',
      classificationProvenance: 'musicbrainz',
      reason: 'MusicBrainz gives the work a catalogue-series reference',
    },
    {
      spotifyTrackId: 'upgrade',
      state: 'unclassified',
      classification: 'uncertain',
      classificationProvenance: 'musicbrainz',
      reason: 'MusicBrainz has no distinguishing evidence',
    },
    {
      spotifyTrackId: 'parser',
      state: 'not_classical',
      classification: 'not_classical',
      classificationProvenance: 'llm_proposal',
      reason: 'the album parser ruled this not classical',
    },
  ];

  await recordAlbumPassOutcomes(outcomes, 'worker-1', completedAt);

  const queueRows = (await db.select().from(schema.matchQueue)).sort((left, right) =>
    left.spotifyId.localeCompare(right.spotifyId),
  );
  assert.deepEqual(
    queueRows.map((row) => ({
      spotifyId: row.spotifyId,
      status: row.status,
      outcome: row.pipelineOutcome,
      reason: row.pipelineReason,
      completedAt: row.pipelineCompletedAt,
      claimOwnerId: row.claimOwnerId,
    })),
    [
      {
        spotifyId: 'manual',
        status: 'matched',
        outcome: 'ready',
        reason: 'MusicBrainz gives the work a catalogue-series reference',
        completedAt,
        claimOwnerId: 'worker-1',
      },
      {
        spotifyId: 'parser',
        status: 'not_classical',
        outcome: 'not_classical',
        reason: 'the album parser ruled this not classical',
        completedAt,
        claimOwnerId: 'worker-1',
      },
      {
        spotifyId: 'upgrade',
        // Nothing to hand the reader, so no worker holds it any more.
        status: 'unresolved',
        outcome: 'unclassified',
        reason: 'MusicBrainz has no distinguishing evidence',
        completedAt,
        claimOwnerId: null,
      },
    ],
  );

  const classificationRows = (await db.select().from(schema.trackClassification)).sort(
    (left, right) => left.spotifyTrackId.localeCompare(right.spotifyTrackId),
  );
  assert.deepEqual(
    classificationRows.map((row) => ({
      spotifyTrackId: row.spotifyTrackId,
      state: row.state,
      provenance: row.provenance,
      reason: row.reason,
      decidedAt: row.decidedAt,
    })),
    [
      {
        spotifyTrackId: 'manual',
        state: 'not_classical',
        provenance: 'manual',
        reason: 'reviewed by hand',
        decidedAt: new Date('2026-09-20T00:00:00Z'),
      },
      {
        spotifyTrackId: 'parser',
        state: 'not_classical',
        provenance: 'llm_proposal',
        reason: 'the album parser ruled this not classical',
        decidedAt: completedAt,
      },
      {
        spotifyTrackId: 'upgrade',
        state: 'uncertain',
        provenance: 'musicbrainz',
        reason: 'MusicBrainz has no distinguishing evidence',
        decidedAt: completedAt,
      },
    ],
  );
});

test('leaves queue rows another worker holds alone', async () => {
  await recordAlbumPassOutcomes(
    [
      {
        spotifyTrackId: 'parser',
        state: 'ready',
        classification: 'classical',
        classificationProvenance: 'musicbrainz',
        reason: 'MusicBrainz gives the work a catalogue-series reference',
      },
    ],
    'worker-2',
  );
  const [row] = await db
    .select()
    .from(schema.matchQueue)
    .where(eq(schema.matchQueue.spotifyId, 'parser'));
  assert.equal(row.status, 'processing');
  assert.equal(row.pipelineOutcome, null);
});
