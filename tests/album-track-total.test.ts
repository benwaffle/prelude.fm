import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import type { Track } from '@spotify/web-api-ts-sdk';
import type { SpotifyAlbumMetadata } from '@/lib/spotify-app-client';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

// An album cached short of what Spotify lists must say so: the total is what the check compares.

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let hydrateProviderAlbum: typeof import('@/lib/provider-hydration').hydrateProviderAlbum;
let invariants: typeof import('@/lib/musicbrainz-invariants').MUSICBRAINZ_INVARIANTS;
let EVERYTHING: typeof import('@/lib/musicbrainz-invariants').EVERYTHING;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ hydrateProviderAlbum } = await import('@/lib/provider-hydration'));
  ({ MUSICBRAINZ_INVARIANTS: invariants, EVERYTHING } =
    await import('@/lib/musicbrainz-invariants'));
});

beforeEach(async () => {
  await resetTestDatabase(db);
});

const album = (total?: number) =>
  ({
    id: 'album-1',
    name: 'An Album',
    release_date: '2021',
    total_tracks: total,
  }) as SpotifyAlbumMetadata;

const track = (id: string, n: number) =>
  ({
    id,
    name: id,
    track_number: n,
    disc_number: 1,
    duration_ms: 200_000,
    artists: [],
    external_ids: {},
  }) as unknown as Track;

async function storedTotal() {
  const [row] = await db.select().from(schema.spotifyAlbum);
  return row.spotifyTrackTotal;
}

async function fullyQueuedViolations() {
  const check = invariants.find((c) => c.name === 'album-is-fully-queued');
  assert.ok(check);
  return db.all<{ id: string; detail: string }>(check.query(EVERYTHING));
}

test("hydrating an album stores Spotify's track total", async () => {
  await hydrateProviderAlbum(album(2), [track('t1', 1), track('t2', 2)], db);
  assert.equal(await storedTotal(), 2);
});

test('a payload without a total does not erase the stored one', async () => {
  await hydrateProviderAlbum(album(2), [track('t1', 1)], db);
  await hydrateProviderAlbum(album(undefined), [track('t1', 1)], db);
  assert.equal(await storedTotal(), 2);
});

test('an album with fewer queued tracks than Spotify lists is a violation', async () => {
  await hydrateProviderAlbum(album(3), [track('t1', 1), track('t2', 2)], db);
  await db.insert(schema.matchQueue).values(
    ['t1', 't2'].map((spotifyId) => ({
      spotifyId,
      spotifyAlbumId: 'album-1',
      submittedBy: 'test',
      status: 'matched' as const,
    })),
  );
  assert.deepEqual(await fullyQueuedViolations(), [{ id: 'album-1', detail: '2 of 3' }]);

  await db
    .insert(schema.matchQueue)
    .values({ spotifyId: 't3', spotifyAlbumId: 'album-1', submittedBy: 'test', status: 'pending' });
  assert.deepEqual(await fullyQueuedViolations(), []);
});

test('an album whose total was never read is not reported', async () => {
  await hydrateProviderAlbum(album(undefined), [track('t1', 1)], db);
  assert.deepEqual(await fullyQueuedViolations(), []);
});
