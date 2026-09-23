import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import type { MbRelease, MusicBrainzSource } from '../app/lib/musicbrainz-source';
import type { AlbumPassDependencies } from '../app/lib/match-queue-processor';
import type { Track } from '@spotify/web-api-ts-sdk';

/**
 * What the queue does with each outcome of a MusicBrainz album pass.
 *
 * The mapping is the point: a track MusicBrainz has nothing to say about must
 * not read as a worker failure, must not be picked up again on the next cron
 * tick, and must not reach the language model at all.
 */

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
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-1',
    title: 'Mozart: Piano Sonatas',
    year: 1990,
    popularity: 33,
    images: null,
    upc: '0000000000001',
    mbReleaseId: null,
    mbReleaseCandidates: null,
    mbCheckedAt: null,
  });
  await db.insert(schema.matchQueue).values(
    ['track-1', 'track-2'].map((spotifyId) => ({
      spotifyId,
      spotifyAlbumId: 'album-1',
      submittedBy: 'test',
      status: 'processing',
      attempts: 1,
      lastAttemptAt: new Date('2026-09-21T00:00:00Z'),
      claimOwnerId: OWNER,
    })),
  );
});

function source(answers: Partial<MusicBrainzSource>): MusicBrainzSource {
  return {
    name: 'fake',
    releasesByBarcode: async () => [],
    searchReleases: async () => [],
    releaseWithRecordings: async () => null,
    releaseRecordingIds: async () => [],
    recordingsByIsrc: async () => new Map(),
    recordingWorks: async () => [],
    recordingDetail: async () => null,
    work: async () => null,
    artist: async () => null,
    ...answers,
  };
}

const ALBUM = {
  id: 'album-1',
  name: 'Mozart: Piano Sonatas',
  uri: 'spotify:album:album-1',
  release_date: '1990-05-01',
  popularity: 33,
  images: [{ url: 'https://example.test/cover.jpg', width: 640, height: 640 }],
};

function spotifyTrack(index: number): Track {
  return {
    id: `track-${index}`,
    name: `Piano Sonata no. 16: movement ${index}`,
    uri: `spotify:track:track-${index}`,
    duration_ms: 200_000 + index,
    disc_number: 1,
    track_number: index,
    popularity: 40,
    external_ids: { isrc: `GBAAA000000${index}` },
    artists: [{ id: 'artist-1', name: 'Mitsuko Uchida' }],
  } as unknown as Track;
}

const readAlbum = async () => ({
  album: ALBUM,
  tracks: [spotifyTrack(1), spotifyTrack(2)],
});

/** A release whose recordings carry the ISRCs Spotify gave us. */
function release(options: { works: boolean }): MbRelease {
  return {
    id: 'release-1',
    title: 'Mozart: Piano Sonatas',
    barcode: '0000000000001',
    date: '1990-05-01',
    country: 'GB',
    tracks: [1, 2].map((position) => ({
      medium: 1,
      position,
      title: `Movement ${position}`,
      length: 200_000 + position,
      recording: {
        id: `rec-${position}`,
        title: `Movement ${position}`,
        length: 200_000 + position,
        isrcs: [`GBAAA000000${position}`],
        works: options.works
          ? [{ id: `part-${position}`, title: `K. 545: movement ${position}` }]
          : [],
        credits: [
          {
            artistId: 'mb-uchida',
            name: 'Mitsuko Uchida',
            role: 'instrument',
            instrument: 'piano',
          },
        ],
        artistCredit: [{ artistId: 'mb-uchida', name: 'Mitsuko Uchida' }],
      },
    })),
  };
}

/** The work tree above a part: its parent sonata and the Köchel catalogue. */
function workTree(id: string) {
  if (id === 'sonata') {
    return {
      id: 'sonata',
      title: 'Piano Sonata no. 16 in C major, K. 545',
      type: 'Sonata',
      relations: [
        {
          type: 'composer',
          direction: 'backward' as const,
          artist: { id: 'mb-mozart', name: 'Wolfgang Amadeus Mozart' },
        },
        {
          type: 'part of',
          direction: 'forward' as const,
          'target-type': 'series',
          series: { id: 'series-k', name: 'Köchel-Verzeichnis', type: 'Catalogue' },
          'attribute-values': { number: 'K. 545' },
        },
      ],
    };
  }
  const position = id.endsWith('1') ? 1 : 2;
  return {
    id,
    title: `K. 545: movement ${position}`,
    type: null,
    relations: [
      {
        type: 'parts',
        direction: 'backward' as const,
        'target-type': 'work',
        'ordering-key': position,
        work: { id: 'sonata', title: 'Piano Sonata no. 16 in C major, K. 545' },
      },
    ],
  };
}

const artist = async (id: string) =>
  id === 'mb-mozart'
    ? {
        id,
        name: 'Wolfgang Amadeus Mozart',
        'sort-name': 'Mozart, Wolfgang Amadeus',
        type: 'Person',
        'life-span': { begin: '1756-01-27', end: '1791-12-05' },
      }
    : { id, name: 'Mitsuko Uchida', 'sort-name': 'Uchida, Mitsuko', type: 'Person' };

/** Spotify's facts for the two tracks, for tests that need them up front. */
async function seedProviderTracks() {
  await db.insert(schema.spotifyTrack).values(
    [1, 2].map((index) => {
      const track = spotifyTrack(index);
      return {
        spotifyId: track.id,
        title: track.name,
        trackNumber: track.track_number,
        discNumber: track.disc_number,
        durationMs: track.duration_ms,
        popularity: track.popularity,
        spotifyAlbumId: ALBUM.id,
        isrc: track.external_ids?.isrc ?? null,
      };
    }),
  );
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
    musicBrainzSource: source({
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
    musicBrainzSource: source({
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
    musicBrainzSource: source({
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
  // The verdict the legacy parser left on the row. MusicBrainz finds no
  // evidence to overturn it, so the pass must not quietly reopen the question.
  await db
    .update(schema.matchQueue)
    .set({ status: 'not_classical' })
    .where(eq(schema.matchQueue.spotifyId, 'track-1'));

  const result = await runPass({
    readAlbum,
    musicBrainzSource: source({
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
    musicBrainzSource: source({
      releasesByBarcode: async () => [],
      searchReleases: async () => [],
    }),
  });

  // What the cron's GET does before it schedules a worker: recover stale
  // claims, retry failures, exhaust the rest.
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
