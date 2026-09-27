import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import type { Track } from '@spotify/web-api-ts-sdk';
import { normalizeIsrc } from '@/lib/isrc';
import type { MusicBrainzSource } from '@/lib/musicbrainz-source';
import type { SpotifyAlbumMetadata } from '@/lib/spotify-app-client';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

/*
 * Spotify occasionally reports an ISRC in lowercase; MusicBrainz never does.
 * The joins between them are plain SQL `=`, so a lowercase spelling made a
 * track read as an ISRC gap after MusicBrainz already had it, and left its
 * submission pending forever.
 */

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let hydrateProviderAlbum: typeof import('@/lib/provider-hydration').hydrateProviderAlbum;
let anchorTracksByIsrc: typeof import('@/lib/musicbrainz-ingest').anchorTracksByIsrc;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ hydrateProviderAlbum } = await import('@/lib/provider-hydration'));
  ({ anchorTracksByIsrc } = await import('@/lib/musicbrainz-ingest'));
});

beforeEach(async () => {
  await resetTestDatabase(db);
});

test('an ISRC is stored trimmed and uppercase', () => {
  assert.equal(normalizeIsrc('usdy42155415'), 'USDY42155415');
  assert.equal(normalizeIsrc('  GBaaa0000001 '), 'GBAAA0000001');
  assert.equal(normalizeIsrc('USDY42155415'), 'USDY42155415');
});

test('a missing ISRC stays missing rather than becoming an empty string', () => {
  assert.equal(normalizeIsrc(null), null);
  assert.equal(normalizeIsrc(undefined), null);
  assert.equal(normalizeIsrc('   '), null);
});

const album = { id: 'album-1', name: 'An Album', release_date: '2021' } as SpotifyAlbumMetadata;

function spotifyTrack(isrc: string | undefined): Track {
  return {
    id: 'track-1',
    name: 'One',
    track_number: 1,
    disc_number: 1,
    duration_ms: 200_000,
    artists: [],
    external_ids: isrc === undefined ? {} : { isrc },
  } as unknown as Track;
}

test('a lowercase ISRC from Spotify is stored uppercase', async () => {
  await hydrateProviderAlbum(album, [spotifyTrack('usdy42155415')], db);
  const [row] = await db.select().from(schema.spotifyTrack);
  assert.equal(row.isrc, 'USDY42155415');
});

test('a payload without an ISRC does not erase the stored one', async () => {
  await hydrateProviderAlbum(album, [spotifyTrack('usdy42155415')], db);
  await hydrateProviderAlbum(album, [spotifyTrack(undefined)], db);
  const [row] = await db.select().from(schema.spotifyTrack);
  assert.equal(row.isrc, 'USDY42155415');
});

test('a track stored with a lowercase ISRC still anchors to the recording MusicBrainz names', async () => {
  // A row written before normalisation: the search answers in MusicBrainz's
  // spelling, and the lookup back to our track must not depend on case.
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-1',
    title: 'An Album',
    year: 2021,
    popularity: null,
    images: null,
  });
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-1',
    title: 'One',
    trackNumber: 1,
    discNumber: 1,
    durationMs: 200_000,
    popularity: null,
    spotifyAlbumId: 'album-1',
    isrc: 'usdy42155415',
  });
  const asked: string[][] = [];
  const source = {
    recordingsByIsrc: async (isrcs: string[]) => {
      asked.push(isrcs);
      return new Map([['USDY42155415', 'rec-1']]);
    },
  } as unknown as MusicBrainzSource;

  const result = await anchorTracksByIsrc(source);

  assert.deepEqual(asked, [['USDY42155415']]);
  assert.equal(result.anchored, 1);
  const [anchor] = await db.select().from(schema.trackRecording);
  assert.equal(anchor.recordingMbid, 'rec-1');
  assert.equal(anchor.isrc, 'USDY42155415');
  const [isrc] = await db.select().from(schema.mbRecordingIsrc);
  assert.equal(isrc.isrc, 'USDY42155415');
});
