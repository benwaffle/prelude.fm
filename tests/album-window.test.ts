import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import test, { before, beforeEach } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
});

beforeEach(async () => {
  await resetTestDatabase(db);
  await db.insert(schema.spotifyAlbum).values(
    ['album-a', 'album-b', 'album-c'].map((spotifyId) => ({
      spotifyId,
      title: `Songs of ${spotifyId}`,
      upc: '0012345678905',
      mbCheckedAt: new Date('2026-10-01T00:00:00Z'),
    })),
  );
  await db.insert(schema.spotifyTrack).values(
    ['album-a', 'album-b', 'album-c'].map((album, index) => ({
      spotifyId: `track-${index}`,
      title: `Track ${index}`,
      trackNumber: 1,
      discNumber: 1,
      durationMs: 180_000,
      spotifyAlbumId: album,
      isrc: null,
    })),
  );
});

test('the library is read a window of albums at a time, in Spotify ID order', async () => {
  const { readAlbumWindow } = await import('@/lib/gaps/album-window');
  const first = await readAlbumWindow(null, 2);
  assert.deepEqual(first, { albumIds: ['album-a', 'album-b'], from: 'album-a', next: 'album-c' });
  const last = await readAlbumWindow(first.next, 2);
  assert.deepEqual(last, { albumIds: ['album-c'], from: 'album-c', next: null });
  assert.deepEqual(await readAlbumWindow('album-d', 2), { albumIds: [], from: null, next: null });
});

test('a gap list covers its window and nothing outside it', async () => {
  const { gapLists } = await import('@/lib/gaps/counts');
  const lists = await gapLists(['album-a', 'album-c']);
  assert.deepEqual(
    lists.missing.map((row) => row.albumId),
    ['album-a', 'album-c'],
  );
});

test('an album title search goes through the index and follows renames', async () => {
  const { matchingAlbums } = await import('@/lib/db/album-search');
  const found = async (query: string) =>
    (await db.all<{ spotify_id: string }>(sql`${matchingAlbums(query, 10)}`)).map(
      (row) => row.spotify_id,
    );
  assert.deepEqual(await found('"album"* "b"*'), ['album-b']);
  await db
    .update(schema.spotifyAlbum)
    .set({ title: 'Winterreise' })
    .where(sql`spotify_id = 'album-b'`);
  assert.deepEqual(await found('"winter"*'), ['album-b']);
  assert.deepEqual(await found('"album"* "b"*'), []);
});
