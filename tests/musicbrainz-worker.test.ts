import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
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

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let runMusicBrainzAlbumPass: typeof import('@/lib/musicbrainz-worker').runMusicBrainzAlbumPass;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ runMusicBrainzAlbumPass } = await import('@/lib/musicbrainz-worker'));
});

beforeEach(async () => {
  await resetTestDatabase(db);
});

async function seedAlbumBarcode() {
  await db.insert(schema.spotifyAlbum).values(ALBUM_ROW);
}

test('writes down what Spotify said before asking MusicBrainz anything', async () => {
  await seedAlbumBarcode();
  const report = await runMusicBrainzAlbumPass(
    fakeSource({
      releasesByBarcode: async () => ['release-1'],
      releaseWithRecordings: async () => release(),
      work: async (id) => workTree(id),
      artist,
    }),
    'album-1',
    ['track-1', 'track-2'],
    { readAlbum },
  );

  const tracks = await db.select().from(schema.spotifyTrack);
  assert.equal(tracks.length, 2, 'the provider facts are written whatever MusicBrainz says');
  assert.deepEqual(tracks.map((track) => track.isrc).sort(), ['GBAAA0000001', 'GBAAA0000002']);
  assert.equal(report.providerTracks, 2);
  assert.equal(report.releaseMbid, 'release-1');
  assert.equal(report.anchored, 2);
});

test('an album MusicBrainz does not have says why, rather than inventing one', async () => {
  await seedAlbumBarcode();
  const report = await runMusicBrainzAlbumPass(
    fakeSource({ releasesByBarcode: async () => [], searchReleases: async () => [] }),
    'album-1',
    ['track-1', 'track-2'],
    { readAlbum },
  );

  assert.equal(report.releaseMbid, null);
  assert.match(report.releaseReason ?? '', /no MusicBrainz release/);
  assert.deepEqual(
    report.tracks.map((track) => track.state),
    ['unanchored', 'unanchored'],
  );
  for (const track of report.tracks) {
    assert.match(track.reason, /MusicBrainz/);
  }
  // Kept as provider facts, so the library can show them as held and unplaceable.
  assert.equal((await db.select().from(schema.spotifyTrack)).length, 2);
});

test('classifies from MusicBrainz evidence, and only calls it classical with some', async () => {
  await seedAlbumBarcode();
  await db.insert(schema.spotifyTrack).values(providerTrackRows());
  await db.insert(schema.trackClassification).values({
    spotifyTrackId: 'track-1',
    state: 'not_classical',
    provenance: 'llm_proposal',
    reason: 'old parser proposal',
    evidenceMbid: null,
    decidedAt: new Date('2026-09-20T00:00:00Z'),
  });
  const report = await runMusicBrainzAlbumPass(
    fakeSource({
      releasesByBarcode: async () => ['release-1'],
      releaseWithRecordings: async () => release(),
      work: async (id) => workTree(id),
      artist,
    }),
    'album-1',
    ['track-1', 'track-2'],
    { readAlbum },
  );

  assert.deepEqual(
    report.tracks.map((track) => track.state),
    ['ready', 'ready'],
  );
  assert.deepEqual(
    report.tracks.map((track) => track.classification),
    ['classical', 'classical'],
  );
  for (const track of report.tracks) {
    assert.match(track.reason, /catalogue-series reference|types .* as Sonata/);
  }
});
