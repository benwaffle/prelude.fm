import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let workRelationshipGaps: typeof import('@/lib/musicbrainz-contributions').workRelationshipGaps;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ workRelationshipGaps } = await import('@/lib/musicbrainz-contributions'));
});

test('a missing work relation keeps its row and offers only MusicBrainz works from sibling recordings', async () => {
  await resetTestDatabase(db);
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album',
    title: 'Album',
    mbReleaseId: 'release',
  });
  await db.insert(schema.spotifyTrack).values([
    {
      spotifyId: 'track-1',
      title: 'First',
      trackNumber: 1,
      durationMs: 1000,
      spotifyAlbumId: 'album',
    },
    {
      spotifyId: 'track-2',
      title: 'Second',
      trackNumber: 2,
      durationMs: 1000,
      spotifyAlbumId: 'album',
    },
  ]);
  await db.insert(schema.mbRelease).values({ mbid: 'release', title: 'Release' });
  await db.insert(schema.mbRecording).values([
    { mbid: 'recording-1', title: 'No work' },
    { mbid: 'recording-2', title: 'Has work' },
  ]);
  await db.insert(schema.mbReleaseTrack).values([
    {
      releaseMbid: 'release',
      medium: 1,
      position: 1,
      recordingMbid: 'recording-1',
      title: 'No work',
    },
    {
      releaseMbid: 'release',
      medium: 1,
      position: 2,
      recordingMbid: 'recording-2',
      title: 'Has work',
    },
  ]);
  await db.insert(schema.trackRecording).values([
    { spotifyTrackId: 'track-1', recordingMbid: 'recording-1', matchedBy: 'release_position' },
    { spotifyTrackId: 'track-2', recordingMbid: 'recording-2', matchedBy: 'release_position' },
  ]);
  await db.insert(schema.mbWork).values({ mbid: 'work', title: 'Known work' });
  await db
    .insert(schema.mbRecordingWork)
    .values({ recordingMbid: 'recording-2', workMbid: 'work' });
  await db.insert(schema.mbWorkCatalogue).values({
    workMbid: 'work',
    seriesMbid: 'series',
    system: 'BWV',
    number: '1',
    normalizedSystem: 'bwv',
    normalizedNumber: '1',
  });

  const gaps = await workRelationshipGaps();
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].recordingMbid, 'recording-1');
  assert.deepEqual(gaps[0].candidates, [
    {
      workMbid: 'work',
      title: 'Known work',
      type: null,
      composerMbid: null,
      composerName: null,
      catalogues: [{ system: 'BWV', number: '1' }],
      evidence: ['same_release_recording'],
    },
  ]);
});
