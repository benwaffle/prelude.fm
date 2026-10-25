import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import type { Track } from '@spotify/web-api-ts-sdk';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import { fakeSource, release, workTree, artist } from './helpers/musicbrainz-fixtures';
import type { MbRelease, MusicBrainzSource } from '../app/lib/musicbrainz-source';
import type { SpotifyCrawlClient } from '../app/lib/spotify-crawl';
import type { SpotifyAlbumWithTrackIds } from '../app/lib/spotify-app-client';

// The crawl reads each album once, queues it through the match queue, records every answer
// Spotify gave (including "none"), and asks nothing twice.

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let crawl: typeof import('@/lib/spotify-crawl');
let cache: typeof import('@/lib/musicbrainz-cache');
let mirror: typeof import('@/lib/musicbrainz-mirror');
let processor: typeof import('@/lib/match-queue-processor');

const link = (albumId: string, ended = false) => ({
  url: `https://open.spotify.com/album/${albumId}`,
  relationshipType: 'free streaming',
  relationshipTypeId: '08445ccf-7b99-4438-9f9a-fb9ac18099ee',
  ended,
  begin: null,
  end: null,
  attributes: [],
});

// Spotify album IDs are 22 characters; the walk ignores links that aren't plain album URLs.
const LINKED = 'AAAAAAAAAAAAAAAAAAAAA1';
const DEAD = 'AAAAAAAAAAAAAAAAAAAAA2';
const SEARCHED = 'AAAAAAAAAAAAAAAAAAAAA3';

// A release whose recordings, ISRCs and barcode are its own.
function releaseNamed(id: string, prefix: string, urlRelations: ReturnType<typeof link>[]) {
  const base = release({ works: true });
  return {
    ...base,
    id,
    barcode: `0${[...prefix].map((c) => c.charCodeAt(0) % 10).join('')}`,
    urlRelations,
    tracks: base.tracks.map((track) => ({
      ...track,
      recording: {
        ...track.recording,
        id: `${id}-rec-${track.position}`,
        isrcs: [`${prefix}000000${track.position}`],
      },
    })),
  } satisfies MbRelease;
}

const RELEASES: Record<string, MbRelease> = {
  'release-linked': releaseNamed('release-linked', 'GBLNK', [link(LINKED)]),
  'release-dead': releaseNamed('release-dead', 'GBDED', [link(DEAD)]),
  'release-search': releaseNamed('release-search', 'GBSRC', []),
  'release-absent': releaseNamed('release-absent', 'GBABS', []),
  'release-held': releaseNamed('release-held', 'GBHLD', [link('BBBBBBBBBBBBBBBBBBBBB1', true)]),
};

function track(albumId: string, position: number, isrc: string): Track {
  return {
    id: `${albumId}-t${position}`,
    name: `Movement ${position}`,
    duration_ms: 200_000 + position,
    disc_number: 1,
    track_number: position,
    popularity: 10,
    external_ids: { isrc },
    artists: [{ id: 'artist-1', name: 'Mitsuko Uchida' }],
    album: { id: albumId },
  } as unknown as Track;
}

const SPOTIFY_TRACKS: Record<string, Track[]> = {
  [LINKED]: [1, 2].map((p) => track(LINKED, p, `GBLNK000000${p}`)),
  [SEARCHED]: [1, 2].map((p) => track(SEARCHED, p, `GBSRC000000${p}`)),
};

function spotifyAlbum(id: string): SpotifyAlbumWithTrackIds {
  return {
    id,
    name: 'Mozart: Piano Sonatas',
    uri: `spotify:album:${id}`,
    release_date: '1990-05-01',
    popularity: 20,
    images: [],
    total_tracks: 2,
    upc: id === SEARCHED ? RELEASES['release-search'].barcode : '999999',
    trackIds: SPOTIFY_TRACKS[id].map((t) => t.id),
    moreTracks: false,
  };
}

function fakeSpotify() {
  const calls: string[] = [];
  let requests = 0;
  const client: SpotifyCrawlClient = {
    async albums(ids) {
      requests++;
      calls.push(`albums ${ids.join(',')}`);
      return ids.map((id) => (SPOTIFY_TRACKS[id] ? spotifyAlbum(id) : null));
    },
    async albumTrackIds(id) {
      requests++;
      calls.push(`albumTrackIds ${id}`);
      return SPOTIFY_TRACKS[id].map((t) => t.id);
    },
    async tracks(ids) {
      requests += Math.ceil(ids.length / 50);
      calls.push(`tracks ${ids.length}`);
      const all = Object.values(SPOTIFY_TRACKS).flat();
      return ids.flatMap((id) => all.filter((t) => t.id === id));
    },
    async searchTracksByIsrc(isrc) {
      requests++;
      calls.push(`search ${isrc}`);
      return Object.values(SPOTIFY_TRACKS)
        .flat()
        .filter((t) => t.external_ids.isrc === isrc);
    },
    requests: () => requests,
  };
  return { client, calls };
}

function webService() {
  const calls: string[] = [];
  const source: MusicBrainzSource = fakeSource({
    releasesByBarcode: async (barcode) => {
      calls.push(`releasesByBarcode ${barcode}`);
      return [];
    },
    searchReleases: async (title) => {
      calls.push(`searchReleases ${title}`);
      return [];
    },
    recordingsByIsrc: async (isrcs) => {
      calls.push(`recordingsByIsrc ${isrcs.join(',')}`);
      return new Map();
    },
    releaseWithRecordings: async (id) => {
      calls.push(`releaseWithRecordings ${id}`);
      return null;
    },
  });
  return { source, calls };
}

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  crawl = await import('@/lib/spotify-crawl');
  cache = await import('@/lib/musicbrainz-cache');
  mirror = await import('@/lib/musicbrainz-mirror');
  processor = await import('@/lib/match-queue-processor');
});

beforeEach(async () => {
  await resetTestDatabase(db);
  // The tables as the dump import leaves them.
  const loader = fakeSource({
    releaseWithRecordings: async (id) => RELEASES[id] ?? null,
    work: async (id) => workTree(id),
    artist,
  });
  for (const id of Object.keys(RELEASES)) await cache.ingestRelease(loader, id);
});

function run(walk: import('../app/lib/spotify-crawl').CrawlWalk, client: SpotifyCrawlClient) {
  const web = webService();
  return {
    web,
    done: crawl.runCrawl(walk, {
      client,
      musicBrainzSource: mirror.musicBrainzMirror(web.source),
      limit: Number.POSITIVE_INFINITY,
      batchSize: 20,
    }),
  };
}

test('linked albums are read in one batch, queued, and matched by the link', async () => {
  const spotify = fakeSpotify();
  const { web, done } = run(crawl.linkedAlbumWalk(), spotify.client);
  const progress = await done;

  assert.equal(progress.stopped, null);
  assert.equal(progress.albumsRead, 1);
  assert.equal(progress.albumsMissing, 1);
  assert.equal(progress.tracksMatched, 2);
  assert.deepEqual(spotify.calls, [`albums ${LINKED},${DEAD}`, 'tracks 2']);
  assert.equal(progress.spotifyRequests, 2, 'two albums and their tracks: two requests');
  assert.equal(progress.musicbrainzRequests, 0);
  assert.deepEqual(web.calls, [], 'the dump already holds the release');

  const [album] = await db
    .select()
    .from(schema.spotifyAlbum)
    .where(eq(schema.spotifyAlbum.spotifyId, LINKED));
  assert.equal(album.mbReleaseId, 'release-linked');
  assert.equal(album.mbReleaseMatchedBy, 'spotify_link');
  assert.equal(album.upc, '999999', 'the barcode Spotify gives is stored');

  const queued = await db.select().from(schema.matchQueue);
  assert.deepEqual(
    queued.map((row) => [row.submittedBy, row.status]),
    [
      ['crawl:mb-link', 'matched'],
      ['crawl:mb-link', 'matched'],
    ],
  );
  assert.equal((await db.select().from(schema.spotifyTrack)).length, 2);

  const recorded = await db.select().from(schema.spotifyCrawl);
  assert.deepEqual(
    recorded.map((row) => [row.subject, row.outcome, row.albumIds]).sort(),
    [
      [LINKED, 'queued', [LINKED]],
      [DEAD, 'not_found', []],
    ],
    'Spotify having no such album is kept',
  );

  // A rerun has nothing left to ask.
  const again = fakeSpotify();
  const rerun = await run(crawl.linkedAlbumWalk(), again.client).done;
  assert.equal(rerun.subjects, 0);
  assert.deepEqual(again.calls, []);
});

test('releases without a link are searched by ISRC, and "not on Spotify" is kept', async () => {
  // A track we hold already carries this release's ISRC: nothing to search.
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'held-album',
    title: 'Held',
    spotifyTrackTotal: 1,
  });
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'held-track',
    title: 'Held',
    trackNumber: 1,
    durationMs: 1,
    spotifyAlbumId: 'held-album',
    isrc: 'GBHLD0000001',
  });

  const spotify = fakeSpotify();
  const { web, done } = run(crawl.isrcSearchWalk(spotify.client), spotify.client);
  const progress = await done;
  assert.equal(progress.stopped, null);
  assert.equal(progress.subjects, 3, 'the linked releases are not searched');
  assert.deepEqual(spotify.calls, [
    'search GBABS0000001',
    'search GBABS0000002',
    'search GBSRC0000001',
    `albums ${SEARCHED}`,
    'tracks 2',
  ]);
  assert.equal(progress.tracksMatched, 2);
  assert.deepEqual(web.calls, [], 'the barcode is answered from the tables');

  const [album] = await db
    .select()
    .from(schema.spotifyAlbum)
    .where(eq(schema.spotifyAlbum.spotifyId, SEARCHED));
  assert.equal(album.mbReleaseId, 'release-search');
  assert.equal(album.mbReleaseMatchedBy, 'barcode');

  const recorded = await db.select().from(schema.spotifyCrawl);
  assert.deepEqual(
    recorded.map((row) => [row.subject, row.outcome, row.isrcs, row.albumIds, row.requests]).sort(),
    [
      ['release-absent', 'not_found', ['GBABS0000001', 'GBABS0000002'], [], 2],
      ['release-held', 'held', ['GBHLD0000001', 'GBHLD0000002'], ['held-album'], 0],
      ['release-search', 'found', ['GBSRC0000001'], [SEARCHED], 1],
    ],
  );
  const rows = await db.select().from(schema.matchQueue);
  assert.ok(rows.every((row) => row.submittedBy === 'crawl:isrc-search'));

  const again = fakeSpotify();
  await run(crawl.isrcSearchWalk(again.client), again.client).done;
  assert.deepEqual(again.calls, [], 'no release is searched twice');
});

test('albums a stopped crawl left queued are finished by the crawl, not the cron worker', async () => {
  await db.insert(schema.matchQueue).values(
    SPOTIFY_TRACKS[LINKED].map((t) => ({
      spotifyId: t.id,
      spotifyAlbumId: LINKED,
      submittedBy: 'crawl:mb-link',
      status: 'pending' as const,
    })),
  );

  const worker = await processor.runMatchQueueWorker({ maxAlbums: 1, musicbrainz: false });
  assert.equal(worker.albums.length, 0, 'the Vercel worker leaves crawl rows alone');

  const spotify = fakeSpotify();
  const progress = await run(crawl.resumeWalk(), spotify.client).done;
  assert.equal(progress.albumsRead, 1);
  assert.equal(progress.tracksMatched, 2);
  const statuses = (await db.select().from(schema.matchQueue)).map((row) => row.status);
  assert.deepEqual(statuses, ['matched', 'matched']);

  // Nothing pending: the next resume has nothing to do.
  const again = fakeSpotify();
  assert.equal((await run(crawl.resumeWalk(), again.client).done).subjects, 0);
  assert.deepEqual(again.calls, []);
});

test('a refusal from Spotify stops the run without recording the batch', async () => {
  const spotify = fakeSpotify();
  spotify.client.albums = async () => {
    throw new Error('Spotify rate limit retry after 3600 seconds for /albums');
  };
  const progress = await run(crawl.linkedAlbumWalk(), spotify.client).done;
  assert.match(progress.stopped ?? '', /retry after 3600/);
  assert.deepEqual(await db.select().from(schema.spotifyCrawl), []);
});

test('the first ISRC and one from the middle are searched', () => {
  assert.deepEqual(crawl.isrcsToSearch([]), []);
  assert.deepEqual(crawl.isrcsToSearch([{ isrc: 'A' }]), ['A']);
  assert.deepEqual(crawl.isrcsToSearch(['A', 'B', 'C', 'D', 'E'].map((isrc) => ({ isrc }))), [
    'A',
    'C',
  ]);
});
