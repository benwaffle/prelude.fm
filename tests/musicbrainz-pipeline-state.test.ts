import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import type { PersistedTrackPassOutcome } from '../app/lib/musicbrainz-pipeline-state';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let persistMusicBrainzTrackOutcomes: typeof import('@/lib/musicbrainz-pipeline-state').persistMusicBrainzTrackOutcomes;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ persistMusicBrainzTrackOutcomes } = await import('@/lib/musicbrainz-pipeline-state'));
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
      status: 'processing',
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

test('stores pipeline completion and preserves classification provenance precedence', async () => {
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

  await persistMusicBrainzTrackOutcomes(outcomes, 'worker-1', completedAt);

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
    })),
    [
      {
        spotifyId: 'manual',
        status: 'processing',
        outcome: 'ready',
        reason: 'MusicBrainz gives the work a catalogue-series reference',
        completedAt,
      },
      {
        spotifyId: 'parser',
        status: 'processing',
        outcome: 'not_classical',
        reason: 'the album parser ruled this not classical',
        completedAt,
      },
      {
        spotifyId: 'upgrade',
        status: 'processing',
        outcome: 'unclassified',
        reason: 'MusicBrainz has no distinguishing evidence',
        completedAt,
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
