import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let anchorAlbumTracks: typeof import('@/lib/musicbrainz-ingest').anchorAlbumTracks;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ anchorAlbumTracks } = await import('@/lib/musicbrainz-ingest'));
});

/**
 * One album of two tracks, and a release whose tracklist lines up with it.
 * Track 1 carries an ISRC MusicBrainz knows; track 2 carries none, so it can
 * only be anchored by its position.
 */
async function seed() {
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-1',
    title: 'An Album',
    year: 2000,
    popularity: null,
    images: null,
    upc: null,
    mbReleaseId: 'release-1',
    mbReleaseCandidates: 1,
    mbCheckedAt: new Date(),
  });
  await db.insert(schema.spotifyTrack).values([
    {
      spotifyId: 'track-1',
      title: 'One',
      trackNumber: 1,
      discNumber: 1,
      durationMs: 200_000,
      popularity: null,
      spotifyAlbumId: 'album-1',
      isrc: 'GBAAA0000001',
    },
    {
      spotifyId: 'track-2',
      title: 'Two',
      trackNumber: 2,
      discNumber: 1,
      durationMs: 300_000,
      popularity: null,
      spotifyAlbumId: 'album-1',
      isrc: null,
    },
  ]);
  await db.insert(schema.mbRelease).values({
    mbid: 'release-1',
    title: 'An Album',
    barcode: null,
    date: '2000',
    country: 'GB',
  });
  await db.insert(schema.mbRecording).values([
    { mbid: 'rec-1', title: 'One', length: 200_000, detail: 'full' },
    { mbid: 'rec-2', title: 'Two', length: 300_000, detail: 'full' },
  ]);
  await db.insert(schema.mbReleaseTrack).values([
    {
      releaseMbid: 'release-1',
      medium: 1,
      position: 1,
      recordingMbid: 'rec-1',
      title: 'One',
      length: 200_000,
    },
    {
      releaseMbid: 'release-1',
      medium: 1,
      position: 2,
      recordingMbid: 'rec-2',
      title: 'Two',
      length: 300_000,
    },
  ]);
  await db.insert(schema.mbRecordingIsrc).values({
    isrc: 'GBAAA0000001',
    recordingMbid: 'rec-1',
  });
}

async function anchorOf(spotifyTrackId: string) {
  const [row] = await db
    .select()
    .from(schema.trackRecording)
    .where(eq(schema.trackRecording.spotifyTrackId, spotifyTrackId));
  return row;
}

beforeEach(async () => {
  await resetTestDatabase(db);
  await seed();
});

test('anchors by ISRC where there is one and by position where there is not', async () => {
  const report = await anchorAlbumTracks('album-1', 'release-1');

  assert.equal(report.anchored, 2);
  assert.equal(report.byIsrc, 1);
  assert.equal(report.byPosition, 1);
  assert.deepEqual(report.conflicts, []);
  assert.equal((await anchorOf('track-1'))?.matchedBy, 'isrc');
  assert.equal((await anchorOf('track-2'))?.matchedBy, 'release_position');
});

test('running the pass again changes nothing', async () => {
  await anchorAlbumTracks('album-1', 'release-1');
  const before = await db.select().from(schema.trackRecording);
  const report = await anchorAlbumTracks('album-1', 'release-1');

  assert.equal(report.replaced, 0);
  assert.deepEqual(report.conflicts, []);
  const after = await db.select().from(schema.trackRecording);
  assert.deepEqual(
    after.map((row) => [row.spotifyTrackId, row.recordingMbid, row.matchedBy]).sort(),
    before.map((row) => [row.spotifyTrackId, row.recordingMbid, row.matchedBy]).sort(),
  );
});

test('a weaker reading does not repoint an anchor we already hold', async () => {
  // The stored anchor came from an ISRC. A later pass reading the position
  // must not quietly move the track to a different recording — that anchor
  // is what the reader has been showing, and what a contribution may have
  // been filed against.
  await db.insert(schema.trackRecording).values({
    spotifyTrackId: 'track-1',
    recordingMbid: 'rec-somewhere-else',
    isrc: 'GBAAA0000001',
    matchedBy: 'isrc',
  });
  await db.delete(schema.mbRecordingIsrc);

  const report = await anchorAlbumTracks('album-1', 'release-1');

  assert.equal((await anchorOf('track-1'))?.recordingMbid, 'rec-somewhere-else');
  assert.equal(report.replaced, 0);
  assert.deepEqual(report.conflicts, [
    {
      spotifyTrackId: 'track-1',
      held: 'rec-somewhere-else',
      heldBy: 'isrc',
      proposed: 'rec-1',
      proposedBy: 'release_position',
    },
  ]);
});

test('an ISRC does replace a position anchor, and says it did', async () => {
  await db.insert(schema.trackRecording).values({
    spotifyTrackId: 'track-1',
    recordingMbid: 'rec-guessed',
    isrc: null,
    matchedBy: 'release_position',
  });

  const report = await anchorAlbumTracks('album-1', 'release-1');

  assert.equal((await anchorOf('track-1'))?.recordingMbid, 'rec-1');
  assert.equal((await anchorOf('track-1'))?.matchedBy, 'isrc');
  assert.equal(report.replaced, 1);
  assert.deepEqual(report.conflicts, []);
});

test('one ISRC naming two recordings anchors nothing and is reported', async () => {
  await db.insert(schema.mbRecordingIsrc).values({
    isrc: 'GBAAA0000001',
    recordingMbid: 'rec-2',
  });

  const report = await anchorAlbumTracks('album-1', 'release-1');

  assert.deepEqual(report.contestedIsrcs, ['GBAAA0000001']);
  // It still gets a position anchor, because the tracklist lines up — the
  // contested ISRC is reported rather than used.
  assert.equal((await anchorOf('track-1'))?.matchedBy, 'release_position');
});
