import assert from 'node:assert/strict';
import test from 'node:test';
import {
  albumKind,
  compareRelease,
  compareTitle,
  movedCount,
  pairTracks,
  sameCredit,
  summariseCorrections,
  type LandedRelease,
  type LandedTrack,
  type RecordingOrigin,
} from '../app/lib/release-corrections';
import type { ReleaseSeed, SeedTrack } from '../app/lib/release-seed';

const vivaldi = { spotifyId: 'sp-vivaldi', name: 'Antonio Vivaldi' };
const carmignola = { spotifyId: 'sp-carm', name: 'Giuliano Carmignola' };
const vbo = { spotifyId: 'sp-vbo', name: 'Venice Baroque Orchestra' };
const mb = {
  vivaldi: { mbid: 'mb-vivaldi', name: 'Antonio Vivaldi' },
  carmignola: { mbid: 'mb-carm', name: 'Giuliano Carmignola' },
  vbo: { mbid: 'mb-vbo', name: 'Venice Baroque Orchestra' },
};

const TITLES = [
  'Concerto in B-Flat: I. Allegro',
  'Concerto in B-Flat: II. Largo',
  'Concerto in B-Flat: III. Presto',
];

function seedTrack(position: number, overrides: Partial<SeedTrack> = {}): SeedTrack {
  return {
    disc: 1,
    position,
    title: TITLES[position - 1],
    durationMs: 100_000 * position,
    isrc: `ISRC000000${position}`,
    artists: [vivaldi, carmignola, vbo],
    ...overrides,
  };
}

function seed(overrides: Partial<ReleaseSeed> = {}): ReleaseSeed {
  return {
    albumId: 'album-1',
    title: 'Concerto Veneziano',
    upc: '1',
    source: 'spotify',
    albumArtists: [carmignola, vbo],
    tracks: [1, 2, 3].map((position) => seedTrack(position)),
    ...overrides,
  };
}

/** Exactly what Harmony would have seeded, landed untouched. */
function landedTrack(position: number, overrides: Partial<LandedTrack> = {}): LandedTrack {
  const artists = [mb.vivaldi, mb.carmignola, mb.vbo];
  return {
    medium: 1,
    position,
    title: TITLES[position - 1],
    lengthMs: 100_000 * position,
    artists,
    recording: { mbid: `rec-${position}`, title: TITLES[position - 1], artists, isrcs: [] },
    ...overrides,
  };
}

function landed(overrides: Partial<LandedRelease> = {}): LandedRelease {
  return {
    mbid: 'release-1',
    title: 'Concerto Veneziano',
    artists: [mb.carmignola, mb.vbo],
    releaseGroup: { mbid: 'rg-1', title: 'Concerto Veneziano', otherReleases: 0 },
    media: 1,
    tracks: [1, 2, 3].map((position) => landedTrack(position)),
    ...overrides,
  };
}

const allCreated = new Map<string, RecordingOrigin>([
  ['rec-1', 'created'],
  ['rec-2', 'created'],
  ['rec-3', 'created'],
]);

test('a release that landed exactly as seeded has no corrections', () => {
  const record = compareRelease({
    seed: seed(),
    baselineSource: 'precheck',
    landed: landed(),
    origins: allCreated,
    composers: 1,
  });
  assert.deepEqual(record.corrections, []);
  assert.deepEqual(record.incomplete, []);
  assert.equal(record.kind, 'single-composer');
  assert.equal(record.tracks.paired, 3);
  assert.equal(record.recordings.created, 3);
  assert.equal(record.releaseGroup, 'new');
});

test('titles: punctuation-only differences are told apart from rewording; case counts as rewording', () => {
  assert.equal(compareTitle('Largo', 'Largo'), 'same');
  assert.equal(compareTitle("Rock 'n' Roll - Live", 'Rock ’n’ Roll – Live'), 'punctuation');
  assert.equal(compareTitle('Concerto in B-Flat Major', 'Concerto in B-flat major'), 'changed');
});

test('credits compare by MusicBrainz identity when known, else by name, ignoring order', () => {
  const mbidOf = (artist: { spotifyId: string | null }) =>
    artist.spotifyId === 'sp-vivaldi' ? 'mb-vivaldi' : null;
  assert.ok(sameCredit([vivaldi], [{ mbid: 'mb-vivaldi', name: 'Vivaldi' }], mbidOf));
  assert.ok(!sameCredit([vivaldi], [{ mbid: 'mb-vivaldi', name: 'Vivaldi' }]));
  assert.ok(sameCredit([vbo, carmignola], [mb.carmignola, mb.vbo]));
  assert.ok(!sameCredit([vivaldi, carmignola], [mb.vivaldi]));
  assert.ok(!sameCredit([vivaldi], [mb.vivaldi, mb.vbo]));
});

test('the classical fix — composer only as track artist, performers on recordings — is measured', () => {
  const record = compareRelease({
    seed: seed(),
    baselineSource: 'precheck',
    landed: landed({
      tracks: [1, 2, 3].map((position) =>
        landedTrack(position, {
          title: TITLES[position - 1].replace('B-Flat', 'B-flat major'),
          artists: [mb.vivaldi],
          recording: {
            mbid: `rec-${position}`,
            title: TITLES[position - 1].replace('B-Flat', 'B-flat major'),
            artists: [mb.carmignola, mb.vbo],
            isrcs: [],
          },
        }),
      ),
    }),
    origins: allCreated,
    composers: 1,
  });
  assert.deepEqual(record.corrections, [
    'track-titles',
    'track-artists',
    'recording-titles',
    'recording-artists',
  ]);
  assert.equal(record.titles.changed, 3);
  assert.equal(record.trackArtists.changed, 3);
  assert.deepEqual(record.trackArtists.examples[0].to, ['Antonio Vivaldi']);
  assert.equal(record.recordings.artistsChanged, 3);
});

test('reused recordings and an existing release group are counted, and make it a new edition', () => {
  const record = compareRelease({
    seed: seed(),
    baselineSource: 'precheck',
    landed: landed({
      releaseGroup: { mbid: 'rg-old', title: 'Concerto Veneziano', otherReleases: 2 },
    }),
    origins: new Map([
      ['rec-1', 'reused'],
      ['rec-2', 'reused'],
      ['rec-3', 'created'],
    ]),
    composers: 1,
  });
  assert.equal(record.kind, 'new-edition');
  assert.deepEqual(record.corrections, ['release-group-reused', 'recordings-reused']);
  assert.equal(record.recordings.reused, 2);
  assert.equal(record.recordings.created, 1);
});

test("unknown recording origins and an unread group are 'incomplete', not zero corrections", () => {
  const record = compareRelease({
    seed: seed({ albumArtists: [], source: 'library' }),
    baselineSource: 'library',
    landed: landed({ releaseGroup: { mbid: 'rg-1', title: 'x', otherReleases: null } }),
    origins: new Map(),
    composers: null,
  });
  assert.deepEqual(record.corrections, []);
  assert.equal(record.incomplete.length, 3);
  assert.equal(record.releaseArtist, null);
  assert.equal(record.releaseGroup, 'unknown');
  assert.equal(record.recordings.unknown, 3);
  assert.equal(record.kind, 'unknown');
});

test('pairing uses ISRC first, then position, then a unique length; leftovers are added or removed', () => {
  const album = seed({
    tracks: [
      seedTrack(1),
      seedTrack(2, { isrc: null }),
      seedTrack(3, { isrc: null, durationMs: 777_000 }),
    ],
  });
  const tracks = [
    // Track 1's reused recording moved to position 2 and carries its ISRC.
    landedTrack(2, {
      lengthMs: 100_000,
      recording: { mbid: 'r1', title: '', artists: [], isrcs: ['isrc0000001'] },
    }),
    // Track 2 moved to position 1; found by length alone.
    landedTrack(1, { lengthMs: 200_000 }),
    // A bonus track nobody seeded.
    landedTrack(3, { lengthMs: 5_000 }),
  ];
  const { pairs, removed, added } = pairTracks(album, tracks);
  assert.deepEqual(
    pairs.map((pair) => [pair.seed.position, pair.landed.position, pair.by]),
    [
      [1, 2, 'isrc'],
      [2, 1, 'duration'],
    ],
  );
  assert.deepEqual(
    removed.map((track) => track.position),
    [3],
  );
  assert.deepEqual(
    added.map((track) => track.lengthMs),
    [5_000],
  );
  assert.equal(movedCount(pairs), 1);
});

test('a removed track shifts positions without counting as a reorder', () => {
  const record = compareRelease({
    seed: seed(),
    baselineSource: 'spotify',
    landed: landed({
      tracks: [
        landedTrack(1),
        landedTrack(2, {
          position: 2,
          lengthMs: 300_000,
          title: TITLES[2],
          recording: {
            mbid: 'rec-3',
            title: TITLES[2],
            artists: [mb.vivaldi, mb.carmignola, mb.vbo],
            isrcs: [],
          },
        }),
      ],
    }),
    origins: allCreated,
    composers: 1,
  });
  assert.equal(record.tracks.removed, 1);
  assert.equal(record.tracks.moved, 0);
  assert.deepEqual(record.corrections, ['tracks-removed']);
});

test('album kind: group first, then discs, then composers, else could not tell', () => {
  assert.equal(albumKind({ releaseGroup: 'reused', media: 4, composers: 3 }).kind, 'new-edition');
  assert.equal(albumKind({ releaseGroup: 'new', media: 4, composers: 1 }).kind, 'box-set');
  assert.equal(albumKind({ releaseGroup: 'new', media: 1, composers: 3 }).kind, 'compilation');
  assert.equal(
    albumKind({ releaseGroup: 'unknown', media: 1, composers: 1 }).kind,
    'single-composer',
  );
  assert.equal(albumKind({ releaseGroup: 'new', media: 1, composers: null }).kind, 'unknown');
});

test('the summary counts untouched albums per kind and ranks the corrections they needed', () => {
  const summary = summariseCorrections([
    { kind: 'single-composer', corrections: [], incomplete: [] },
    { kind: 'single-composer', corrections: [], incomplete: ['x'] },
    { kind: 'single-composer', corrections: ['track-artists', 'track-titles'], incomplete: [] },
    { kind: 'compilation', corrections: ['track-artists'], incomplete: [] },
    { kind: 'compilation', corrections: ['track-artists', 'release-artist'], incomplete: [] },
  ]);
  assert.deepEqual(summary, [
    {
      kind: 'single-composer',
      albums: 3,
      untouched: 1,
      untouchedIncomplete: 1,
      byType: [
        { type: 'track-artists', albums: 1 },
        { type: 'track-titles', albums: 1 },
      ],
    },
    {
      kind: 'compilation',
      albums: 2,
      untouched: 0,
      untouchedIncomplete: 0,
      byType: [
        { type: 'track-artists', albums: 2 },
        { type: 'release-artist', albums: 1 },
      ],
    },
  ]);
});
