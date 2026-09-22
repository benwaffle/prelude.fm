import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { createTestDatabase, resetTestDatabase } from './helpers/test-database';
import type { ClassicalMetadataV2 } from '@/lib/classical-parser';
import type { TrackMetadataSaveInput } from '@/lib/track-metadata-save';

type Database = Awaited<ReturnType<typeof createTestDatabase>>;

let db: Database;
let schema: typeof import('@/lib/db/schema');
let saveTrackMetadataInternal: typeof import('@/lib/track-metadata-save').saveTrackMetadataInternal;
let saveParsedAlbumV2: typeof import('@/lib/work-parts-v2').saveParsedAlbumV2;

const ALBUM_ID = 'album-wtc';

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ saveTrackMetadataInternal } = await import('@/lib/track-metadata-save'));
  ({ saveParsedAlbumV2 } = await import('@/lib/work-parts-v2'));
});

beforeEach(async () => {
  await resetTestDatabase(db);
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: ALBUM_ID,
    title: 'Das wohltemperierte Klavier I',
    year: 1997,
    images: [],
    popularity: 40,
  });
  await db.insert(schema.spotifyArtist).values([
    { spotifyId: 'artist-jsb', name: 'Johann Sebastian Bach', popularity: null, images: null },
    { spotifyId: 'artist-cpe', name: 'Carl Philipp Emanuel Bach', popularity: null, images: null },
  ]);
  // Two composers sharing a surname. A parse that credits only "Bach" is
  // ambiguous and resolves to neither — the everyday way an album arrives
  // with some tracks resolvable and some not.
  await db.insert(schema.composer).values([
    { name: 'Johann Sebastian Bach', spotifyArtistId: 'artist-jsb' },
    { name: 'Carl Philipp Emanuel Bach', spotifyArtistId: 'artist-cpe' },
  ]);
});

function parsed(overrides: Partial<ClassicalMetadataV2>): ClassicalMetadataV2 {
  return {
    isClassical: true,
    composerName: 'Johann Sebastian Bach',
    formalName: 'Das wohltemperierte Klavier I',
    nickname: null,
    catalogSystem: 'BWV',
    catalogNumber: '846',
    form: 'prelude',
    yearComposed: 1722,
    recordingGroup: 'Das wohltemperierte Klavier I',
    parts: [{ position: 1, label: 'I', title: 'Praeludium' }],
    ...overrides,
  } as ClassicalMetadataV2;
}

function baseSave(
  trackId: string,
  trackNumber: number,
  metadata: ClassicalMetadataV2,
): TrackMetadataSaveInput {
  const part = metadata.parts[0];
  assert.ok(metadata.composerName, 'every fixture track carries a credited composer');
  return {
    album: {
      id: ALBUM_ID,
      name: 'Das wohltemperierte Klavier I',
      release_date: '1997-01-01',
      popularity: 40,
      images: [],
      inSpotifyAlbumsTable: true,
    },
    track: {
      id: trackId,
      name: `${metadata.formalName}: ${part.title}`,
      uri: `spotify:track:${trackId}`,
      duration_ms: 120_000,
      disc_number: 1,
      track_number: trackNumber,
      popularity: 30,
      inSpotifyTracksTable: false,
    },
    artists: [{ id: 'artist-jsb', name: 'Johann Sebastian Bach', inSpotifyArtistsTable: true }],
    metadata: {
      // The base save keys the composer off the Spotify artist, so it succeeds
      // even where the v2 pass cannot tell two same-surname composers apart.
      composerArtistId: 'artist-jsb',
      composerName: metadata.composerName,
      formalName: metadata.formalName,
      nickname: metadata.nickname,
      catalogSystem: metadata.catalogSystem,
      catalogNumber: metadata.catalogNumber,
      form: metadata.form,
      movementNumber: part.position,
      movementName: part.title,
      yearComposed: metadata.yearComposed,
    },
  };
}

/** Mirrors how the queue processor saves an album: base rows, then the v2 pass. */
function saveAlbum(
  items: Array<{ trackId: string; trackNumber: number; parsed: ClassicalMetadataV2 }>,
) {
  return db.transaction(async (transaction) => {
    for (const item of items) {
      await saveTrackMetadataInternal(
        baseSave(item.trackId, item.trackNumber, item.parsed),
        transaction,
      );
    }
    return saveParsedAlbumV2(
      ALBUM_ID,
      items.map((item) => ({ id: item.trackId, discNumber: 1, trackNumber: item.trackNumber })),
      items.map((item) => item.parsed),
      transaction,
    );
  });
}

async function publishedRowCounts() {
  const [works, parts, partLinks, recordings, memberships] = await Promise.all([
    db.select({ id: schema.work.id }).from(schema.work),
    db.select({ id: schema.workPartV2.id }).from(schema.workPartV2),
    db.select({ id: schema.trackWorkPartV2.spotifyTrackId }).from(schema.trackWorkPartV2),
    db.select({ id: schema.recordingV2.id }).from(schema.recordingV2),
    db.select({ id: schema.recordingTrackV2.spotifyTrackId }).from(schema.recordingTrackV2),
  ]);
  return {
    works: works.length,
    parts: parts.length,
    partLinks: partLinks.length,
    recordings: recordings.length,
    memberships: memberships.length,
  };
}

/** The K.466-shaped corruption: a track linked to a part but to no recording. */
async function orphanedPartLinks() {
  const partLinks = await db
    .select({ trackId: schema.trackWorkPartV2.spotifyTrackId })
    .from(schema.trackWorkPartV2);
  const memberships = await db
    .select({ trackId: schema.recordingTrackV2.spotifyTrackId })
    .from(schema.recordingTrackV2);
  const held = new Set(memberships.map((row) => row.trackId));
  return [...new Set(partLinks.map((row) => row.trackId))].filter((id) => !held.has(id));
}

test('publishes an album whose every classical track resolves', async () => {
  const result = await saveAlbum([
    { trackId: 'track-a', trackNumber: 1, parsed: parsed({}) },
    {
      trackId: 'track-b',
      trackNumber: 2,
      parsed: parsed({ parts: [{ position: 2, label: 'II', title: 'Fuga' }] }),
    },
  ]);

  assert.equal(result.groups, 1);
  assert.deepEqual(await orphanedPartLinks(), []);
  const memberships = await db
    .select({ trackId: schema.recordingTrackV2.spotifyTrackId })
    .from(schema.recordingTrackV2);
  assert.deepEqual(memberships.map((row) => row.trackId).sort(), ['track-a', 'track-b']);
});

test('refuses the whole album when one classical track has no resolvable work', async () => {
  await assert.rejects(
    saveAlbum([
      { trackId: 'track-a', trackNumber: 1, parsed: parsed({}) },
      {
        trackId: 'track-b',
        trackNumber: 2,
        parsed: parsed({
          // Ambiguous between the two Bachs, so the v2 pass resolves no work.
          composerName: 'Bach',
          catalogNumber: '847',
          parts: [{ position: 1, label: 'I', title: 'Praeludium' }],
        }),
      },
    ]),
    (error: Error) => {
      assert.equal(error.name, 'UnresolvedAlbumWorkError');
      assert.match(error.message, /track-b/);
      assert.match(error.message, /Bach/);
      return true;
    },
  );

  // Nothing at all was published: the resolvable track must not go out while
  // its album-mate is stranded, and no track may keep a part link with no
  // recording behind it.
  assert.deepEqual(await publishedRowCounts(), {
    works: 0,
    parts: 0,
    partLinks: 0,
    recordings: 0,
    memberships: 0,
  });
  assert.deepEqual(await orphanedPartLinks(), []);
});

test('leaves an earlier good save untouched when a later album pass fails', async () => {
  await saveAlbum([{ trackId: 'track-a', trackNumber: 1, parsed: parsed({}) }]);
  const before = await publishedRowCounts();

  await assert.rejects(
    saveAlbum([
      {
        trackId: 'track-c',
        trackNumber: 3,
        parsed: parsed({ composerName: 'Bach', catalogNumber: '848' }),
      },
    ]),
  );

  assert.deepEqual(await publishedRowCounts(), before);
  assert.deepEqual(await orphanedPartLinks(), []);
  const held = await db
    .select({ trackId: schema.recordingTrackV2.spotifyTrackId })
    .from(schema.recordingTrackV2)
    .where(eq(schema.recordingTrackV2.spotifyTrackId, 'track-a'));
  assert.equal(held.length, 1);
});
