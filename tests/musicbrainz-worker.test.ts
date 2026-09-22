import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import type { MbRelease, MusicBrainzSource } from '../app/lib/musicbrainz-source';
import type { Track } from '@spotify/web-api-ts-sdk';

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

function source(answers: Partial<MusicBrainzSource>): MusicBrainzSource {
  return {
    name: 'fake',
    releasesByBarcode: async () => [],
    searchReleases: async () => [],
    releaseWithRecordings: async () => null,
    releaseRecordingIds: async () => [],
    recordingsByIsrc: async () => new Map(),
    recordingWorks: async () => [],
    recordingDetail: async () => null,
    work: async () => null,
    artist: async () => null,
    ...answers,
  };
}

const ALBUM = {
  id: 'album-1',
  name: 'Mozart: Piano Sonatas',
  uri: 'spotify:album:album-1',
  release_date: '1990-05-01',
  popularity: 33,
  images: [{ url: 'https://example.test/cover.jpg', width: 640, height: 640 }],
};

function spotifyTrack(index: number, isrc: string): Track {
  return {
    id: `track-${index}`,
    name: `Piano Sonata no. 16: movement ${index}`,
    uri: `spotify:track:track-${index}`,
    duration_ms: 200_000 + index,
    disc_number: 1,
    track_number: index,
    popularity: 40,
    external_ids: { isrc },
    artists: [{ id: 'artist-1', name: 'Mitsuko Uchida' }],
  } as unknown as Track;
}

const SPOTIFY_ALBUM = {
  album: ALBUM,
  tracks: [spotifyTrack(1, 'GBAAA0000001'), spotifyTrack(2, 'GBAAA0000002')],
};

function release(): MbRelease {
  return {
    id: 'release-1',
    title: 'Mozart: Piano Sonatas',
    barcode: '0000000000001',
    date: '1990-05-01',
    country: 'GB',
    tracks: [1, 2].map((position) => ({
      medium: 1,
      position,
      title: `Movement ${position}`,
      length: 200_000 + position,
      recording: {
        id: `rec-${position}`,
        title: `Movement ${position}`,
        length: 200_000 + position,
        isrcs: [`GBAAA000000${position}`],
        works: [{ id: `part-${position}`, title: `K. 545: movement ${position}` }],
        credits: [
          {
            artistId: 'mb-uchida',
            name: 'Mitsuko Uchida',
            role: 'instrument',
            instrument: 'piano',
          },
        ],
        artistCredit: [{ artistId: 'mb-uchida', name: 'Mitsuko Uchida' }],
      },
    })),
  };
}

/** The work tree MusicBrainz returns for a part: its parent and a catalogue. */
function workTree(id: string) {
  if (id === 'sonata') {
    return {
      id: 'sonata',
      title: 'Piano Sonata no. 16 in C major, K. 545',
      type: 'Sonata',
      relations: [
        {
          type: 'composer',
          direction: 'backward' as const,
          artist: { id: 'mb-mozart', name: 'Wolfgang Amadeus Mozart' },
        },
        {
          type: 'part of',
          direction: 'forward' as const,
          'target-type': 'series',
          series: { id: 'series-k', name: 'Köchel-Verzeichnis', type: 'Catalogue' },
          'attribute-values': { number: 'K. 545' },
        },
      ],
    };
  }
  const position = id.endsWith('1') ? 1 : 2;
  return {
    id,
    title: `K. 545: movement ${position}`,
    type: null,
    relations: [
      {
        type: 'parts',
        direction: 'backward' as const,
        'target-type': 'work',
        'ordering-key': position,
        work: { id: 'sonata', title: 'Piano Sonata no. 16 in C major, K. 545' },
      },
    ],
  };
}

async function seedAlbumBarcode() {
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-1',
    title: 'Mozart: Piano Sonatas',
    year: 1990,
    popularity: 33,
    images: null,
    upc: '0000000000001',
    mbReleaseId: null,
    mbReleaseCandidates: null,
    mbCheckedAt: null,
  });
}

test('writes down what Spotify said before asking MusicBrainz anything', async () => {
  await seedAlbumBarcode();
  const report = await runMusicBrainzAlbumPass(
    source({
      releasesByBarcode: async () => ['release-1'],
      releaseWithRecordings: async () => release(),
      work: async (id) => workTree(id),
      artist: async (id) =>
        id === 'mb-mozart'
          ? {
              id,
              name: 'Wolfgang Amadeus Mozart',
              'sort-name': 'Mozart, Wolfgang Amadeus',
              type: 'Person',
              'life-span': { begin: '1756-01-27', end: '1791-12-05' },
            }
          : { id, name: 'Mitsuko Uchida', 'sort-name': 'Uchida, Mitsuko', type: 'Person' },
    }),
    'album-1',
    ['track-1', 'track-2'],
    { readAlbum: async () => SPOTIFY_ALBUM },
  );

  const tracks = await db.select().from(schema.spotifyTrack);
  assert.equal(tracks.length, 2, 'the provider facts are written whatever MusicBrainz says');
  assert.deepEqual(tracks.map((track) => track.isrc).sort(), ['GBAAA0000001', 'GBAAA0000002']);
  assert.equal(report.providerTracks, 2);
  assert.equal(report.releaseMbid, 'release-1');
  assert.equal(report.anchored, 2);
});

test('nothing is written to the legacy classical tables', async () => {
  await seedAlbumBarcode();
  await runMusicBrainzAlbumPass(
    source({
      releasesByBarcode: async () => ['release-1'],
      releaseWithRecordings: async () => release(),
      work: async (id) => workTree(id),
      artist: async (id) => ({ id, name: 'Somebody', 'sort-name': 'Somebody', type: 'Person' }),
    }),
    'album-1',
    ['track-1', 'track-2'],
    { readAlbum: async () => SPOTIFY_ALBUM },
  );

  // The pass calls no language model, so there is nothing to assert a
  // composer or a work from, and nothing lands in the tables that used to
  // hold those assertions.
  for (const table of [
    schema.composer,
    schema.work,
    schema.workPartV2,
    schema.recordingV2,
    schema.trackWorkPartV2,
    schema.recordingTrackV2,
  ]) {
    assert.deepEqual(await db.select().from(table), [], 'a legacy table was written to');
  }
});

test('an album MusicBrainz does not have says why, rather than inventing one', async () => {
  await seedAlbumBarcode();
  const report = await runMusicBrainzAlbumPass(
    source({ releasesByBarcode: async () => [], searchReleases: async () => [] }),
    'album-1',
    ['track-1', 'track-2'],
    { readAlbum: async () => SPOTIFY_ALBUM },
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
  // The tracks still exist as provider facts, so the library can show them
  // as held and unplaceable rather than losing them.
  assert.equal((await db.select().from(schema.spotifyTrack)).length, 2);
});

test('classifies from MusicBrainz evidence, and only calls it classical with some', async () => {
  await seedAlbumBarcode();
  const report = await runMusicBrainzAlbumPass(
    source({
      releasesByBarcode: async () => ['release-1'],
      releaseWithRecordings: async () => release(),
      work: async (id) => workTree(id),
      artist: async (id) =>
        id === 'mb-mozart'
          ? {
              id,
              name: 'Wolfgang Amadeus Mozart',
              'sort-name': 'Mozart, Wolfgang Amadeus',
              type: 'Person',
              'life-span': { begin: '1756-01-27', end: '1791-12-05' },
            }
          : { id, name: 'Mitsuko Uchida', 'sort-name': 'Uchida, Mitsuko', type: 'Person' },
    }),
    'album-1',
    ['track-1', 'track-2'],
    { readAlbum: async () => SPOTIFY_ALBUM },
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
