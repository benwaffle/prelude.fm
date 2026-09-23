import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let loadMusicBrainzAlbumRows: typeof import('../app/admin/lib/musicbrainz-album-coverage').loadMusicBrainzAlbumRows;
let loadMusicBrainzAlbumTracks: typeof import('../app/admin/lib/musicbrainz-album-coverage').loadMusicBrainzAlbumTracks;
let summarizeMusicBrainzAlbumCoverage: typeof import('../app/admin/lib/musicbrainz-album-coverage').summarizeMusicBrainzAlbumCoverage;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ loadMusicBrainzAlbumRows, loadMusicBrainzAlbumTracks, summarizeMusicBrainzAlbumCoverage } =
    await import('../app/admin/lib/musicbrainz-album-coverage'));
});

beforeEach(async () => {
  await resetTestDatabase(db);

  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-1',
    title: 'Provider Album',
    year: 2026,
    upc: '000000000001',
    mbReleaseId: 'release-1',
    mbReleaseCandidates: 1,
    mbCheckedAt: new Date('2026-09-22T00:00:00Z'),
  });
  await db.insert(schema.spotifyTrack).values(
    ['track-1', 'track-2', 'track-3', 'track-4'].map((spotifyId, index) => ({
      spotifyId,
      title: `Provider Track ${index + 1}`,
      trackNumber: index + 1,
      discNumber: 1,
      durationMs: 180_000,
      spotifyAlbumId: 'album-1',
      isrc: index < 3 ? `GBAAA000000${index + 1}` : null,
    })),
  );

  await db.insert(schema.trackRecording).values([
    {
      spotifyTrackId: 'track-1',
      recordingMbid: 'recording-1',
      isrc: 'GBAAA0000001',
      matchedBy: 'isrc',
    },
    {
      spotifyTrackId: 'track-2',
      recordingMbid: 'recording-cache-missing',
      isrc: 'GBAAA0000002',
      matchedBy: 'isrc',
    },
  ]);
  await db.insert(schema.mbRecording).values({
    mbid: 'recording-1',
    title: 'MusicBrainz Recording',
    detail: 'full',
  });
  await db.insert(schema.mbRecordingWork).values([
    { recordingMbid: 'recording-1', workMbid: 'work-child' },
    { recordingMbid: 'recording-1', workMbid: 'work-cache-missing' },
  ]);
  await db.insert(schema.mbWork).values([
    {
      mbid: 'work-parent',
      title: 'MusicBrainz Parent',
      type: 'Sonata',
      detail: 'full',
    },
    {
      mbid: 'work-child',
      title: 'MusicBrainz Movement',
      parentMbid: 'work-parent',
      orderingKey: 1,
      detail: 'full',
    },
  ]);
  await db.insert(schema.trackClassification).values([
    {
      spotifyTrackId: 'track-1',
      state: 'classical',
      provenance: 'musicbrainz',
      evidenceMbid: 'work-child',
      decidedAt: new Date('2026-09-22T00:00:00Z'),
    },
    {
      spotifyTrackId: 'track-2',
      state: 'uncertain',
      provenance: 'musicbrainz',
      reason: 'recording has no work relationship',
      decidedAt: new Date('2026-09-22T00:00:00Z'),
    },
    {
      spotifyTrackId: 'track-3',
      state: 'not_classical',
      provenance: 'manual',
      decidedAt: new Date('2026-09-22T00:00:00Z'),
    },
  ]);
});

test('Albums counts only provider, classification, anchor, and MusicBrainz facts', async () => {
  const [album] = await loadMusicBrainzAlbumRows(db);

  assert.deepEqual(album, {
    id: 'album-1',
    title: 'Provider Album',
    year: 2026,
    upc: '000000000001',
    mbReleaseId: 'release-1',
    candidates: 1,
    checked: new Date('2026-09-22T00:00:00.000Z'),
    tracks: 4,
    anchored: 2,
    classified: 3,
    classical: 1,
    tracksReachingWork: 1,
    works: 2,
    worksCached: 1,
    state: 'partial',
  });

  assert.deepEqual(summarizeMusicBrainzAlbumCoverage([album]), {
    albums: 1,
    tracks: 4,
    anchoredTracks: 2,
    classifiedTracks: 3,
    classicalTracks: 1,
    tracksReachingWork: 1,
    byState: [{ state: 'partial', albums: 1, tracks: 4 }],
  });
});

test('Albums track detail exposes missing MB facts instead of parser substitutes', async () => {
  const tracks = await loadMusicBrainzAlbumTracks('album-1', db);
  const anchored = tracks.find((track) => track.id === 'track-1');
  const missingRecordingCache = tracks.find((track) => track.id === 'track-2');
  const parserOnly = tracks.find((track) => track.id === 'track-3');
  const unclassified = tracks.find((track) => track.id === 'track-4');

  assert.equal(anchored?.recordingTitle, 'MusicBrainz Recording');
  assert.deepEqual(anchored?.classification, {
    state: 'classical',
    provenance: 'musicbrainz',
    reason: null,
  });
  assert.deepEqual(
    anchored?.works.map((work) => ({
      mbid: work.mbid,
      title: work.title,
      parentTitle: work.parentTitle,
    })),
    [
      { mbid: 'work-cache-missing', title: null, parentTitle: null },
      {
        mbid: 'work-child',
        title: 'MusicBrainz Movement',
        parentTitle: 'MusicBrainz Parent',
      },
    ],
  );

  assert.equal(missingRecordingCache?.recordingMbid, 'recording-cache-missing');
  assert.equal(missingRecordingCache?.recordingTitle, null);
  assert.deepEqual(missingRecordingCache?.works, []);
  assert.deepEqual(parserOnly?.works, []);
  assert.equal(unclassified?.classification, null);
});
