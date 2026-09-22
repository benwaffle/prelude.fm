import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import test, { before, beforeEach } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import { projectMusicBrainzLibrary } from '../app/lib/musicbrainz-library';
import { musicBrainzLibraryView } from '../app/lib/musicbrainz-library-view';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let loadMusicBrainzLibraryFacts: typeof import('@/app/actions/library-musicbrainz').loadMusicBrainzLibraryFacts;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ loadMusicBrainzLibraryFacts } = await import('@/app/actions/library-musicbrainz'));
});

/** Two of a sonata's three movements, on one album, anchored by ISRC. */
async function seedPartialSonata() {
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-1',
    title: 'Mozart: Piano Sonatas',
    year: 1990,
    popularity: 30,
    images: [{ url: 'https://example.test/cover.jpg', width: 640, height: 640 }],
    upc: null,
    mbReleaseId: null,
    mbReleaseCandidates: null,
    mbCheckedAt: null,
  });
  await db.insert(schema.spotifyTrack).values([
    {
      spotifyId: 'track-i',
      title: 'Piano Sonata No. 16: I. Allegro',
      trackNumber: 1,
      discNumber: 1,
      durationMs: 240_000,
      popularity: 44,
      spotifyAlbumId: 'album-1',
      isrc: 'GBAAA0000011',
    },
    {
      spotifyId: 'track-ii',
      title: 'Piano Sonata No. 16: II. Andante',
      trackNumber: 2,
      discNumber: 1,
      durationMs: 300_000,
      popularity: 40,
      spotifyAlbumId: 'album-1',
      isrc: 'GBAAA0000012',
    },
  ]);
  await db.insert(schema.trackRecording).values([
    { spotifyTrackId: 'track-i', recordingMbid: 'rec-i', isrc: 'GBAAA0000011', matchedBy: 'isrc' },
    {
      spotifyTrackId: 'track-ii',
      recordingMbid: 'rec-ii',
      isrc: 'GBAAA0000012',
      matchedBy: 'isrc',
    },
  ]);
  await db.insert(schema.mbRecording).values([
    { mbid: 'rec-i', title: 'Allegro', length: 240_000, detail: 'full' },
    { mbid: 'rec-ii', title: 'Andante', length: 300_000, detail: 'full' },
  ]);
  await db.insert(schema.mbRecordingWork).values([
    { recordingMbid: 'rec-i', workMbid: 'part-i' },
    { recordingMbid: 'rec-ii', workMbid: 'part-ii' },
  ]);
  await db.insert(schema.mbWork).values([
    {
      mbid: 'sonata',
      title: 'Piano Sonata no. 16 in C major, K. 545',
      type: 'Sonata',
      parentMbid: null,
      orderingKey: null,
      composerMbid: 'mozart',
      detail: 'full',
    },
    {
      mbid: 'part-i',
      title: 'Piano Sonata no. 16 in C major, K. 545: I. Allegro',
      type: null,
      parentMbid: 'sonata',
      orderingKey: 1,
      composerMbid: 'mozart',
      detail: 'full',
    },
    {
      mbid: 'part-ii',
      title: 'Piano Sonata no. 16 in C major, K. 545: II. Andante',
      type: null,
      parentMbid: 'sonata',
      orderingKey: 2,
      composerMbid: 'mozart',
      detail: 'full',
    },
    {
      mbid: 'part-iii',
      title: 'Piano Sonata no. 16 in C major, K. 545: III. Rondo',
      type: null,
      parentMbid: 'sonata',
      orderingKey: 3,
      composerMbid: 'mozart',
      detail: 'full',
    },
  ]);
  await db.insert(schema.mbWorkCatalogue).values({
    workMbid: 'sonata',
    seriesMbid: 'series-k',
    system: 'K.',
    number: '545',
    normalizedSystem: 'k',
    normalizedNumber: '545',
  });
  await db.insert(schema.mbArtist).values([
    {
      mbid: 'mozart',
      name: 'Wolfgang Amadeus Mozart',
      creditedName: null,
      sortName: 'Mozart, Wolfgang Amadeus',
      type: 'Person',
      beginYear: 1756,
      endYear: 1791,
    },
    {
      mbid: 'pianist',
      name: 'Mitsuko Uchida',
      creditedName: 'Mitsuko Uchida',
      sortName: 'Uchida, Mitsuko',
      type: 'Person',
      beginYear: null,
      endYear: null,
    },
  ]);
  await db.insert(schema.mbRecordingCredit).values([
    { recordingMbid: 'rec-i', artistMbid: 'pianist', role: 'instrument', instrument: 'piano' },
    { recordingMbid: 'rec-ii', artistMbid: 'pianist', role: 'instrument', instrument: 'piano' },
  ]);
}

async function view(trackIds: string[]) {
  const facts = await loadMusicBrainzLibraryFacts(trackIds);
  return musicBrainzLibraryView(projectMusicBrainzLibrary(facts), new Set(trackIds));
}

beforeEach(async () => {
  await resetTestDatabase(db);
  await seedPartialSonata();
});

test('gathers the movements of one work on one issue into a single card', async () => {
  const { works } = await view(['track-i', 'track-ii']);

  assert.equal(works.length, 1);
  const [card] = works;
  assert.equal(card.workId, 'sonata', 'the card is the sonata, not its movements');
  assert.equal(card.title, 'Piano Sonata no. 16 in C major, K. 545');
  assert.equal(card.composerFull, 'Wolfgang Amadeus Mozart');
  assert.equal(card.composerId, 'mozart');
  assert.equal(card.catalog, 'K. 545');
  assert.equal(card.era, 'Classical');
  assert.equal(card.performer, 'Mitsuko Uchida');
  // Nobody has looked for this album's MusicBrainz release, and the card
  // says so rather than presenting itself as complete.
  assert.deepEqual(card.gaps, ['release-not-checked']);
});

test('names movements from MusicBrainz, never from the Spotify track title', async () => {
  const { works } = await view(['track-i', 'track-ii']);
  const played = works[0].movements.filter((movement) => !movement.missing);

  assert.deepEqual(
    played.map((movement) => movement.name),
    [
      'Piano Sonata no. 16 in C major, K. 545: I. Allegro',
      'Piano Sonata no. 16 in C major, K. 545: II. Andante',
    ],
  );
  assert.deepEqual(
    played.map((movement) => movement.trackId),
    ['track-i', 'track-ii'],
  );
});

test('shows the movement this issue does not carry as missing, from MusicBrainz', async () => {
  const { works } = await view(['track-i', 'track-ii']);
  const missing = works[0].movements.filter((movement) => movement.missing);

  assert.deepEqual(
    missing.map((movement) => movement.name),
    ['Piano Sonata no. 16 in C major, K. 545: III. Rondo'],
  );
  assert.equal(missing[0].trackId, null);
  assert.equal(missing[0].durationMs, null, 'we do not know how long a part we do not hold is');
  assert.deepEqual(
    works[0].movements.map((movement) => movement.n),
    [1, 2, 3],
  );
});

test('two performances of one work stay two cards', async () => {
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-2',
    title: 'Another Mozart Recital',
    year: 2015,
    popularity: 10,
    images: null,
    upc: null,
    mbReleaseId: null,
    mbReleaseCandidates: null,
    mbCheckedAt: null,
  });
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-other-i',
    title: 'Sonata 16: Allegro',
    trackNumber: 1,
    discNumber: 1,
    durationMs: 250_000,
    popularity: 9,
    spotifyAlbumId: 'album-2',
    isrc: 'GBAAA0000021',
  });
  await db.insert(schema.trackRecording).values({
    spotifyTrackId: 'track-other-i',
    recordingMbid: 'rec-other-i',
    isrc: 'GBAAA0000021',
    matchedBy: 'isrc',
  });
  await db.insert(schema.mbRecording).values({
    mbid: 'rec-other-i',
    title: 'Allegro',
    length: 250_000,
    detail: 'full',
  });
  await db.insert(schema.mbRecordingWork).values({
    recordingMbid: 'rec-other-i',
    workMbid: 'part-i',
  });

  const { works } = await view(['track-i', 'track-ii', 'track-other-i']);
  assert.equal(works.length, 2);
  assert.deepEqual(
    works.map((card) => card.workId),
    ['sonata', 'sonata'],
  );
  assert.equal(new Set(works.map((card) => card.id)).size, 2);
});

test('a card carries the gap codes behind it rather than looking complete', async () => {
  await db.delete(schema.mbArtist).where(eq(schema.mbArtist.mbid, 'mozart'));

  const { works } = await view(['track-i', 'track-ii']);
  assert.equal(works[0].composerFull, null);
  assert.ok(works[0].gaps.includes('composer-cache-missing'));
});

test('every held track is on a card or in the gap list, exactly once', async () => {
  const requested = ['track-i', 'track-ii', 'never-seen'];
  const { works, unresolvedTracks, accounting } = await view(requested);

  const onCards = works.flatMap((card) =>
    card.movements.flatMap((movement) => (movement.trackId ? [movement.trackId] : [])),
  );
  const inGaps = unresolvedTracks.map((track) => track.spotifyTrackId);
  assert.deepEqual([...onCards, ...inGaps].sort(), [...requested].sort());
  assert.deepEqual(
    accounting.map((track) => track.spotifyTrackId),
    requested,
  );
});

test('the detail of a work gathers every issue of it we can play', async () => {
  await db.insert(schema.spotifyAlbum).values({
    spotifyId: 'album-2',
    title: 'Another Mozart Recital',
    year: 2015,
    popularity: 10,
    images: null,
    upc: null,
    mbReleaseId: null,
    mbReleaseCandidates: null,
    mbCheckedAt: null,
  });
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-other-i',
    title: 'Sonata 16: Allegro',
    trackNumber: 1,
    discNumber: 1,
    durationMs: 250_000,
    popularity: 9,
    spotifyAlbumId: 'album-2',
    isrc: 'GBAAA0000021',
  });
  await db.insert(schema.trackRecording).values({
    spotifyTrackId: 'track-other-i',
    recordingMbid: 'rec-other-i',
    isrc: 'GBAAA0000021',
    matchedBy: 'isrc',
  });
  await db.insert(schema.mbRecording).values({
    mbid: 'rec-other-i',
    title: 'Allegro',
    length: 250_000,
    detail: 'full',
  });
  await db.insert(schema.mbRecordingWork).values({
    recordingMbid: 'rec-other-i',
    workMbid: 'part-i',
  });

  const { getMusicBrainzWorkDetail } = await import('@/app/actions/library-mb');
  const detail = await getMusicBrainzWorkDetail('sonata', null, ['track-i']);

  assert.ok(detail);
  // The two-movement holding is fuller than the one-movement one, and
  // fullness is a fact about what we hold, not a guess at which is better.
  assert.equal(detail.work.movements.filter((movement) => !movement.missing).length, 2);
  assert.equal(detail.others.length, 1);
  assert.equal(detail.others[0].album, 'Another Mozart Recital');
  assert.equal(
    detail.others[0].popularity,
    null,
    'Spotify popularity belongs to a track, and nothing has aggregated it per recording',
  );
});

test('asking for a work MusicBrainz cannot play returns nothing, not an empty card', async () => {
  const { getMusicBrainzWorkDetail } = await import('@/app/actions/library-mb');
  assert.equal(await getMusicBrainzWorkDetail('not-a-work', null, []), null);
});

test('a collection names every part MusicBrainz lists, held or not', async () => {
  const { getMusicBrainzWorkParent } = await import('@/app/actions/library-mb');
  const collection = await getMusicBrainzWorkParent('part-i');

  assert.ok(collection);
  assert.equal(collection.title, 'Piano Sonata no. 16 in C major, K. 545');
  assert.deepEqual(
    collection.siblings.map((sibling) => [sibling.title, sibling.workId !== null]),
    [
      ['I. Allegro', true],
      ['II. Andante', true],
      // MusicBrainz lists a third movement we hold nothing for. It stays on
      // the list, unlinked, so the collection reads as two of three.
      ['III. Rondo', false],
    ],
  );
  assert.equal(collection.held, 2);
  assert.equal(collection.siblings.filter((sibling) => sibling.isCurrent).length, 1);
});

test('a work with no collection above it has none, rather than an empty one', async () => {
  const { getMusicBrainzWorkParent } = await import('@/app/actions/library-mb');
  assert.equal(await getMusicBrainzWorkParent('sonata'), null);
});

test('a collection counts a part we hold only through its own parts', async () => {
  // A prelude and fugue is one part of the Well-Tempered Clavier and two
  // recordings beneath it. Asking only about the part's own recordings would
  // report the collection as emptier than it is.
  await db.insert(schema.mbWork).values([
    {
      mbid: 'wtc',
      title: 'The Well-Tempered Clavier, Book 1',
      type: 'Suite',
      parentMbid: null,
      orderingKey: null,
      composerMbid: 'mozart',
      detail: 'full',
    },
    {
      mbid: 'wtc-1',
      title: 'The Well-Tempered Clavier, Book 1: Prelude and Fugue no. 1',
      type: null,
      parentMbid: 'wtc',
      orderingKey: 1,
      composerMbid: 'mozart',
      detail: 'full',
    },
    {
      mbid: 'wtc-1-prelude',
      title: 'Prelude',
      type: null,
      parentMbid: 'wtc-1',
      orderingKey: 1,
      composerMbid: 'mozart',
      detail: 'full',
    },
    {
      mbid: 'wtc-2',
      title: 'The Well-Tempered Clavier, Book 1: Prelude and Fugue no. 2',
      type: null,
      parentMbid: 'wtc',
      orderingKey: 2,
      composerMbid: 'mozart',
      detail: 'full',
    },
  ]);
  await db.insert(schema.mbRecording).values({
    mbid: 'rec-wtc-prelude',
    title: 'Prelude',
    length: 100_000,
    detail: 'full',
  });
  await db.insert(schema.mbRecordingWork).values({
    recordingMbid: 'rec-wtc-prelude',
    workMbid: 'wtc-1-prelude',
  });
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-wtc',
    title: 'WTC I: Prelude no. 1',
    trackNumber: 1,
    discNumber: 1,
    durationMs: 100_000,
    popularity: 1,
    spotifyAlbumId: 'album-1',
    isrc: 'GBAAA0000031',
  });
  await db.insert(schema.trackRecording).values({
    spotifyTrackId: 'track-wtc',
    recordingMbid: 'rec-wtc-prelude',
    isrc: 'GBAAA0000031',
    matchedBy: 'isrc',
  });

  const { getMusicBrainzWorkParent } = await import('@/app/actions/library-mb');
  const collection = await getMusicBrainzWorkParent('wtc-1');

  assert.ok(collection);
  assert.deepEqual(
    collection.siblings.map((sibling) => [sibling.ordering, sibling.workId !== null]),
    [
      [1, true],
      [2, false],
    ],
  );
  assert.equal(collection.held, 1);
});

test('the catalogue lists only works we can play, under the same identity as a card', async () => {
  const { getMusicBrainzCatalogComposers, getMusicBrainzCatalogWorks } =
    await import('@/app/actions/catalog-mb');
  const composers = await getMusicBrainzCatalogComposers();
  assert.deepEqual(
    composers.map((entry) => [entry.id, entry.name, entry.workCount, entry.recordingCount]),
    [['mozart', 'Wolfgang Amadeus Mozart', 1, 2]],
  );
  assert.equal(composers[0].era, 'Classical');
  assert.equal(composers[0].image, null, 'MusicBrainz has no portrait to show');

  const works = await getMusicBrainzCatalogWorks('mozart');
  assert.deepEqual(
    works.map((work) => [work.id, work.catalog, work.movementCount, work.recordingCount]),
    [['sonata', 'K. 545', 3, 2]],
  );
  // The same identity the library card carries, so a card's catalogue number
  // leads to a work the catalogue actually lists.
  const { works: cards } = await view(['track-i']);
  assert.equal(cards[0].workId, works[0].id);
});

test('searching a catalogue reference finds the work it is filed against', async () => {
  const { searchMusicBrainzWorks } = await import('@/app/actions/catalog-mb');
  const hits = await searchMusicBrainzWorks('K. 545');

  assert.deepEqual(
    hits.map((hit) => [hit.workId, hit.composerName, hit.matchedOn, hit.recordingCount]),
    [['sonata', 'Wolfgang Amadeus Mozart', 'K. 545', 2]],
  );
});

test('searching a composer finds their works, and one we cannot play does not appear', async () => {
  await db.insert(schema.mbWork).values({
    mbid: 'unplayable',
    title: 'Piano Sonata no. 17',
    type: 'Sonata',
    parentMbid: null,
    orderingKey: null,
    composerMbid: 'mozart',
    detail: 'full',
  });

  const { searchMusicBrainzWorks } = await import('@/app/actions/catalog-mb');
  const byComposer = await searchMusicBrainzWorks('mozart');
  const byTitle = await searchMusicBrainzWorks('sonata no');

  assert.deepEqual(
    byTitle.map((hit) => hit.workId),
    ['sonata'],
  );
  const hits = byComposer;

  assert.deepEqual(
    hits.map((hit) => hit.workId),
    ['sonata'],
  );
});

test('a medley appears under each work it performs, and is accounted for once', async () => {
  // MusicBrainz relates one recording to two works. Filing it under one of
  // them would be choosing arbitrarily; filing it under both is what
  // MusicBrainz actually says. The per-track accounting is still one row.
  await db.insert(schema.mbWork).values({
    mbid: 'fantasia',
    title: 'Fantasia in D minor, K. 397',
    type: 'Fantasia',
    parentMbid: null,
    orderingKey: null,
    composerMbid: 'mozart',
    detail: 'full',
  });
  await db.insert(schema.mbWorkCatalogue).values({
    workMbid: 'fantasia',
    seriesMbid: 'series-k',
    system: 'K.',
    number: '397',
    normalizedSystem: 'k',
    normalizedNumber: '397',
  });
  await db.insert(schema.mbRecordingWork).values({
    recordingMbid: 'rec-i',
    workMbid: 'fantasia',
  });

  const { works, accounting } = await view(['track-i']);

  assert.deepEqual(
    works.map((card) => card.workId).sort(),
    ['fantasia', 'sonata'],
    'both works MusicBrainz names, neither chosen over the other',
  );
  for (const card of works) {
    assert.deepEqual(
      card.movements.filter((movement) => !movement.missing).map((movement) => movement.trackId),
      ['track-i'],
    );
  }
  assert.deepEqual(
    accounting.map((track) => track.spotifyTrackId),
    ['track-i'],
  );
});

test('the work heading reads the same values as the catalogue row', async () => {
  const { getMusicBrainzCatalogWorkHeader, getMusicBrainzCatalogWorks } =
    await import('@/app/actions/catalog-mb');
  const [row] = await getMusicBrainzCatalogWorks('mozart');
  const header = await getMusicBrainzCatalogWorkHeader('sonata');

  assert.ok(header);
  // The heading is scoped to one work rather than shaping the whole held
  // catalogue, so it has to be checked against the list it sits above.
  assert.equal(header.id, row.id);
  assert.equal(header.title, row.title);
  assert.equal(header.catalog, row.catalog);
  assert.equal(header.genre, row.genre);
  assert.equal(header.movementCount, row.movementCount);
  assert.equal(header.composerName, 'Wolfgang Amadeus Mozart');
});

test('the heading finds a catalogue number filed on the work above', async () => {
  const { getMusicBrainzCatalogWorkHeader } = await import('@/app/actions/catalog-mb');
  // part-i has no catalogue of its own; K. 545 is on the sonata.
  const header = await getMusicBrainzCatalogWorkHeader('part-i');

  assert.equal(header?.catalog, 'K. 545');
  assert.equal(header?.composerName, 'Wolfgang Amadeus Mozart');
});
