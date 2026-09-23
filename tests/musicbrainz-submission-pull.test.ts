import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import type {
  MbRelease,
  MbReleaseRecording,
  MusicBrainzSource,
} from '../app/lib/musicbrainz-source';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let adoptReleaseForAlbum: typeof import('../app/lib/musicbrainz-submission-pull').adoptReleaseForAlbum;
let ingestRecording: typeof import('../app/lib/musicbrainz-cache').ingestRecording;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ adoptReleaseForAlbum } = await import('../app/lib/musicbrainz-submission-pull'));
  ({ ingestRecording } = await import('../app/lib/musicbrainz-cache'));
});

beforeEach(async () => {
  await resetTestDatabase(db);
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

function recording(id: string, extras: Partial<MbReleaseRecording> = {}): MbReleaseRecording {
  return {
    id,
    title: id,
    length: 200_000,
    isrcs: [],
    works: [],
    credits: [],
    artistCredit: [],
    ...extras,
  };
}

function release(): MbRelease {
  return {
    id: 'release-live',
    title: 'Best - Bach',
    barcode: '7340070445640',
    date: '2012-03-21',
    country: 'XW',
    urlRelations: [],
    tracks: [
      {
        medium: 1,
        position: 1,
        title: 'Air',
        length: 254_400,
        recording: recording('rec-1', { title: 'Air', length: 254_400 }),
      },
    ],
  };
}

async function seedUnmatchedAlbum() {
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-1',
    title: 'Best - Bach',
    upc: '07340070445640',
    mbReleaseId: null,
    mbReleaseCandidates: 0,
  });
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-1',
    title: 'Air',
    trackNumber: 1,
    discNumber: 1,
    durationMs: 254_400,
    popularity: null,
    spotifyAlbumId: 'album-1',
    isrc: null,
  });
}

test('adoptReleaseForAlbum ingests a live MBID the barcode search does not yet know', async () => {
  await seedUnmatchedAlbum();
  const live = release();
  const api = source({
    releasesByBarcode: async () => [],
    releaseWithRecordings: async (id) => (id === live.id ? live : null),
  });

  const result = await adoptReleaseForAlbum(api, 'album-1', live.id);
  assert.deepEqual(result, { attached: true, releaseMbid: live.id });

  const [album] = await db
    .select({ mbReleaseId: schema.spotifyAlbum.mbReleaseId })
    .from(schema.spotifyAlbum)
    .where(eq(schema.spotifyAlbum.spotifyId, 'album-1'));
  assert.equal(album?.mbReleaseId, live.id);

  const [cached] = await db
    .select({ mbid: schema.mbRelease.mbid, barcode: schema.mbRelease.barcode })
    .from(schema.mbRelease)
    .where(eq(schema.mbRelease.mbid, live.id));
  assert.equal(cached?.barcode, '7340070445640');

  const [anchor] = await db
    .select({ recordingMbid: schema.trackRecording.recordingMbid })
    .from(schema.trackRecording)
    .where(eq(schema.trackRecording.spotifyTrackId, 'track-1'));
  assert.equal(anchor?.recordingMbid, 'rec-1');
});

test('ingestRecording rewrites work links from a later MusicBrainz read', async () => {
  await seedUnmatchedAlbum();
  await db.insert(schema.mbRecording).values({
    mbid: 'rec-1',
    title: 'Air',
    length: 254_400,
    detail: 'full',
  });
  await db.insert(schema.mbRecordingWork).values({
    recordingMbid: 'rec-1',
    workMbid: 'stale-work',
  });
  await db.insert(schema.trackRecording).values({
    spotifyTrackId: 'track-1',
    recordingMbid: 'rec-1',
    isrc: null,
    matchedBy: 'release_position',
  });

  const api = source({
    recordingDetail: async () =>
      recording('rec-1', {
        title: 'Air',
        works: [{ id: 'work-1', title: 'Orchestral Suite No. 3: Air' }],
        isrcs: ['DEB790303001'],
      }),
  });

  const result = await ingestRecording(api, 'rec-1');
  assert.equal(result.found, true);

  const links = await db
    .select()
    .from(schema.mbRecordingWork)
    .where(eq(schema.mbRecordingWork.recordingMbid, 'rec-1'));
  assert.equal(links.length, 1);
  assert.equal(links[0]?.workMbid, 'work-1');

  const isrcs = await db
    .select()
    .from(schema.mbRecordingIsrc)
    .where(eq(schema.mbRecordingIsrc.recordingMbid, 'rec-1'));
  assert.equal(isrcs[0]?.isrc, 'DEB790303001');
});
