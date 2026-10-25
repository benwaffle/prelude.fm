import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import {
  ALBUM_ROW,
  artist,
  fakeSource,
  providerTrackRows,
  release,
  workTree,
} from './helpers/musicbrainz-fixtures';
import type { MbRelease, MusicBrainzSource } from '../app/lib/musicbrainz-source';

// The mirror answers what our tables hold whole, asks the web service for the rest, and an answer
// it read from the tables is never written back.

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let mirror: typeof import('@/lib/musicbrainz-mirror');
let cache: typeof import('@/lib/musicbrainz-cache');
let ingest: typeof import('@/lib/musicbrainz-ingest');
let matching: typeof import('@/lib/musicbrainz-matching');

const SPOTIFY_LINK = {
  url: 'https://open.spotify.com/album/album-1',
  relationshipType: 'free streaming',
  relationshipTypeId: '08445ccf-7b99-4438-9f9a-fb9ac18099ee',
  ended: false,
  begin: null,
  end: null,
  attributes: [],
};

function webRelease(id = 'release-1', urlRelations = [SPOTIFY_LINK]): MbRelease {
  return { ...release({ works: true }), id, urlRelations };
}

// What the web service would answer, and a count of every question put to it.
function countingWebService(answers: Partial<MusicBrainzSource> = {}) {
  const calls: string[] = [];
  const base = fakeSource({
    releaseWithRecordings: async (id) => (id === 'release-1' ? webRelease() : null),
    work: async (id) => workTree(id),
    artist,
    ...answers,
  });
  const counted = Object.fromEntries(
    Object.entries(base).map(([key, value]) => [
      key,
      typeof value === 'function'
        ? (...args: unknown[]) => {
            calls.push(`${key}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`);
            return (value as (...args: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  ) as unknown as MusicBrainzSource;
  return { source: counted, calls };
}

const WATCHED = [
  'mb_release',
  'mb_release_track',
  'mb_release_url',
  'mb_recording',
  'mb_recording_isrc',
  'mb_recording_work',
  'mb_recording_credit',
  'mb_work',
  'mb_work_catalogue',
  'mb_artist',
  'track_recording',
];

// Triggers rather than timestamps: an upsert that writes the same values is still a write.
async function watchWrites() {
  await db.run(sql.raw('create table if not exists write_log (tbl text not null)'));
  for (const table of WATCHED) {
    for (const event of ['insert', 'update', 'delete']) {
      await db.run(
        sql.raw(
          `create trigger if not exists log_${table}_${event} after ${event} on ${table}
           begin insert into write_log (tbl) values ('${table}'); end`,
        ),
      );
    }
  }
  await db.run(sql.raw('delete from write_log'));
}

async function writesSince(): Promise<string[]> {
  const rows = await db.all<{ tbl: string }>(sql.raw('select tbl from write_log'));
  return rows.map((row) => row.tbl);
}

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  mirror = await import('@/lib/musicbrainz-mirror');
  cache = await import('@/lib/musicbrainz-cache');
  ingest = await import('@/lib/musicbrainz-ingest');
  matching = await import('@/lib/musicbrainz-matching');
});

beforeEach(async () => {
  await resetTestDatabase(db);
  await db.insert(schema.spotifyAlbum).values(ALBUM_ROW);
  await db.insert(schema.spotifyTrack).values(providerTrackRows());
});

// The cache as the web-service path (or the dump import, which writes the same shape) leaves it.
async function cacheFromWebService() {
  const web = countingWebService({ releasesByBarcode: async () => ['release-1'] });
  await ingest.ingestAlbum(web.source, 'album-1', { fetchWorks: true });
}

test('a release cached whole is answered from the tables, without the web service', async () => {
  await cacheFromWebService();
  const web = countingWebService();
  const source = mirror.musicBrainzMirror(web.source);

  const answer = await source.releaseWithRecordings('release-1');
  assert.deepEqual(web.calls, []);
  assert.ok(answer);
  const expected = webRelease();
  assert.equal(answer.title, expected.title);
  assert.equal(answer.barcode, expected.barcode);
  assert.deepEqual(answer.urlRelations, [SPOTIFY_LINK]);
  assert.deepEqual(
    answer.tracks.map((track) => ({
      ...track,
      recording: { ...track.recording, artistCredit: [] },
    })),
    expected.tracks.map((track) => ({
      ...track,
      recording: { ...track.recording, artistCredit: [] },
    })),
  );

  assert.deepEqual(await source.releasesByBarcode('0000000000001'), ['release-1']);
  assert.deepEqual(await source.releasesByBarcode('1'), ['release-1'], 'padding is ignored');
  assert.deepEqual(await source.releaseRecordingIds('release-1'), ['rec-1', 'rec-2']);
  assert.deepEqual(await source.recordingWorks('rec-1'), [
    { id: 'part-1', title: 'K. 545: movement 1' },
  ]);
  assert.equal((await source.recordingDetail('rec-2'))?.isrcs[0], 'GBAAA0000002');
  assert.equal((await source.work('sonata'))?.title, 'Piano Sonata no. 16 in C major, K. 545');
  assert.deepEqual(await source.releasesLinkedToSpotifyAlbum!('album-1'), ['release-1']);
  assert.deepEqual(
    [...(await source.recordingsByIsrc(['GBAAA0000001']))],
    [['GBAAA0000001', 'rec-1']],
  );
  assert.deepEqual(web.calls, [], 'every one of these is held');
});

test('what the tables lack is asked of the web service, and only that', async () => {
  await cacheFromWebService();
  const web = countingWebService({
    recordingsByIsrc: async (isrcs) => new Map(isrcs.map((isrc) => [isrc, `web-${isrc}`])),
    releasesByBarcode: async () => ['web-release'],
  });
  const source = mirror.musicBrainzMirror(web.source);

  assert.equal(await source.releaseWithRecordings('release-2'), null);
  assert.deepEqual(await source.releasesByBarcode('999'), ['web-release']);
  assert.deepEqual(
    await source.recordingsByIsrc(['GBAAA0000001', 'GBAAA0000009']),
    new Map([
      ['GBAAA0000001', 'rec-1'],
      ['GBAAA0000009', 'web-GBAAA0000009'],
    ]),
  );
  await source.searchReleases('Mozart', 2);
  assert.deepEqual(web.calls, [
    'releaseWithRecordings("release-2")',
    'releasesByBarcode("999")',
    'recordingsByIsrc(["GBAAA0000009"])',
    'searchReleases("Mozart", 2)',
  ]);
});

test('a release cached before its URL links were read is not served as whole', async () => {
  await cacheFromWebService();
  await db
    .update(schema.mbRelease)
    .set({ urlRelationsFetchedAt: null })
    .where(eq(schema.mbRelease.mbid, 'release-1'));
  const web = countingWebService();
  await mirror.musicBrainzMirror(web.source).releaseWithRecordings('release-1');
  assert.deepEqual(web.calls, ['releaseWithRecordings("release-1")']);
});

test('a release with a recording held only as a stub is not served as whole', async () => {
  await cacheFromWebService();
  await db
    .update(schema.mbRecording)
    .set({ detail: 'stub' })
    .where(eq(schema.mbRecording.mbid, 'rec-2'));
  const web = countingWebService();
  await mirror.musicBrainzMirror(web.source).releaseWithRecordings('release-1');
  assert.deepEqual(web.calls, ['releaseWithRecordings("release-1")']);
});

test('re-ingesting a release cached whole costs no writes and no requests', async () => {
  await cacheFromWebService();
  await watchWrites();
  const web = countingWebService();
  const source = mirror.musicBrainzMirror(web.source);

  const report = await cache.ingestRelease(source, 'release-1', { fetchWorks: true });
  assert.equal(report.found, true);
  assert.equal(report.requests, 0);
  assert.equal(report.tracks, 2);
  assert.equal(report.isrcs, 2);
  assert.equal(report.credits, 2);

  const album = await ingest.ingestAlbum(source, 'album-1', { fetchWorks: true });
  assert.equal(album.requests, 0);
  assert.equal(album.anchors?.anchored, 2, 'held anchors still count as anchored');

  assert.deepEqual(web.calls, []);
  assert.deepEqual(await writesSince(), []);
});

test('MusicBrainz’s link to the Spotify album identifies the release before the barcode', async () => {
  // The barcode points elsewhere; the link is MusicBrainz saying which release this album is.
  await cache.ingestRelease(
    fakeSource({ releaseWithRecordings: async () => webRelease() }),
    'release-1',
  );
  const web = countingWebService({ releasesByBarcode: async () => ['barcode-release'] });

  const result = await ingest.ingestAlbum(mirror.musicBrainzMirror(web.source), 'album-1');
  assert.equal(result.releaseMbid, 'release-1');
  assert.equal(result.matchedBy, 'spotify_link');
  assert.deepEqual(
    web.calls.filter((call) => !call.startsWith('work(')),
    [],
    'neither the barcode nor the release was asked for (only the works it never read)',
  );

  const [row] = await db.select().from(schema.spotifyAlbum);
  assert.equal(row.mbReleaseId, 'release-1');
  assert.equal(row.mbReleaseMatchedBy, 'spotify_link', 'the album says how it was matched');
});

test('an ended link does not identify the release', async () => {
  await cache.ingestRelease(
    fakeSource({
      releaseWithRecordings: async () =>
        webRelease('release-1', [{ ...SPOTIFY_LINK, ended: true }]),
    }),
    'release-1',
  );
  const source = mirror.musicBrainzMirror(
    countingWebService({ releasesByBarcode: async () => ['release-1'] }).source,
  );
  const result = await ingest.ingestAlbum(source, 'album-1');
  assert.equal(result.matchedBy, 'barcode');
  const [row] = await db.select().from(schema.spotifyAlbum);
  assert.equal(row.mbReleaseMatchedBy, 'barcode');
});

test('two linked releases with different recordings fall through to the barcode', async () => {
  const album = { spotifyId: 'album-1', title: 'x', upc: '1', mbReleaseId: null };
  const recordings: Record<string, string[]> = { a: ['r1'], b: ['r2'], c: ['r3'] };
  const source = fakeSource({
    releasesLinkedToSpotifyAlbum: async () => ['a', 'b'],
    releaseRecordingIds: async (id) => recordings[id],
    releasesByBarcode: async () => ['b'],
  });
  const result = await matching.findReleaseForAlbum(source, album, []);
  assert.equal(result.releaseMbid, 'b');
  assert.equal(result.releaseMbid && result.matchedBy, 'barcode');

  const same = fakeSource({
    releasesLinkedToSpotifyAlbum: async () => ['a', 'c'],
    releaseRecordingIds: async () => ['r1'],
    releasesByBarcode: async () => {
      throw new Error('the link already answered');
    },
  });
  const linked = await matching.findReleaseForAlbum(same, album, []);
  assert.equal(linked.releaseMbid, 'a');
  assert.equal(linked.releaseMbid && linked.matchedBy, 'spotify_link');
});
