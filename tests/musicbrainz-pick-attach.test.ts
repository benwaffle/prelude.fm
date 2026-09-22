import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let attachPickedRelease: typeof import('../app/lib/musicbrainz-contributions').attachPickedRelease;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ attachPickedRelease } = await import('../app/lib/musicbrainz-contributions'));
});

beforeEach(async () => {
  await resetTestDatabase(db);
});

test('attachPickedRelease writes mbReleaseId when the release is already cached', async () => {
  await db.insert(schema.mbRelease).values({ mbid: 'release-1', title: 'Album' });
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-1',
    title: 'Album',
    upc: '00731453988228',
    mbReleaseId: null,
    mbReleaseCandidates: 3,
  });

  const result = await attachPickedRelease({ albumId: 'album-1', releaseMbid: 'release-1' });
  assert.deepEqual(result, { attached: true, releaseMbid: 'release-1' });

  const [album] = await db
    .select({
      mbReleaseId: schema.spotifyAlbum.mbReleaseId,
      mbReleaseCandidates: schema.spotifyAlbum.mbReleaseCandidates,
    })
    .from(schema.spotifyAlbum)
    .where(eq(schema.spotifyAlbum.spotifyId, 'album-1'));
  assert.equal(album?.mbReleaseId, 'release-1');
  assert.equal(album?.mbReleaseCandidates, 1);
});

test('attachPickedRelease refuses to invent a cache row for a live lookup hit', async () => {
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-1',
    title: 'Album',
    upc: '00731453988228',
    mbReleaseId: null,
    mbReleaseCandidates: 3,
  });

  const result = await attachPickedRelease({
    albumId: 'album-1',
    releaseMbid: 'release-live-only',
  });
  assert.deepEqual(result, { attached: false, reason: 'release_not_in_cache' });

  const [album] = await db
    .select({ mbReleaseId: schema.spotifyAlbum.mbReleaseId })
    .from(schema.spotifyAlbum)
    .where(eq(schema.spotifyAlbum.spotifyId, 'album-1'));
  assert.equal(album?.mbReleaseId, null);
});

test('attachPickedRelease leaves an already matched album alone', async () => {
  await db.insert(schema.mbRelease).values({ mbid: 'release-1', title: 'Album' });
  await db.insert(schema.mbRelease).values({ mbid: 'release-2', title: 'Other' });
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-1',
    title: 'Album',
    upc: '00731453988228',
    mbReleaseId: 'release-1',
    mbReleaseCandidates: 1,
  });

  const result = await attachPickedRelease({ albumId: 'album-1', releaseMbid: 'release-2' });
  assert.deepEqual(result, { attached: false, reason: 'album_already_matched' });
});
