import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import test, { before, beforeEach } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import { projectMusicBrainzLibrary } from '../app/lib/musicbrainz-library';
import {
  albumSections,
  keepLikedHoldings,
  musicBrainzLibraryView,
} from '../app/lib/musicbrainz-library-view';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let loadMusicBrainzLibraryFacts: typeof import('@/lib/musicbrainz-library-read').loadMusicBrainzLibraryFacts;
let findAlbumMateTrackIds: typeof import('@/lib/musicbrainz-work-queries').findAlbumMateTrackIds;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ loadMusicBrainzLibraryFacts } = await import('@/lib/musicbrainz-library-read'));
  ({ findAlbumMateTrackIds } = await import('@/lib/musicbrainz-work-queries'));
});

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
  // Nobody has looked for this album's release, and the card says so.
  assert.deepEqual(card.gaps, ['release-not-checked']);
});

test('names movements from MusicBrainz, never from the Spotify track title', async () => {
  const { works } = await view(['track-i', 'track-ii']);
  const played = works[0].movements.filter((movement) => !movement.missing);

  assert.deepEqual(
    played.map((movement) => movement.name),
    ['Allegro', 'Andante'],
    'named within the work, which the card already titles',
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
    ['Rondo'],
  );
  assert.equal(missing[0].trackId, null);
  assert.equal(missing[0].durationMs, null, 'we do not know how long a part we do not hold is');
  assert.deepEqual(
    works[0].movements.map((movement) => movement.n),
    [1, 2, 3],
  );
});

async function libraryOf(likedTrackIds: string[]) {
  const liked = new Set(likedTrackIds);
  const facts = await loadMusicBrainzLibraryFacts(await findAlbumMateTrackIds(likedTrackIds));
  return keepLikedHoldings(musicBrainzLibraryView(projectMusicBrainzLibrary(facts), liked), liked);
}

test("liking one movement puts the album's other movements on the card, playable", async () => {
  // An album-mate that MusicBrainz cannot place, and nobody liked.
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-encore',
    title: 'Encore',
    trackNumber: 3,
    discNumber: 1,
    durationMs: 120_000,
    popularity: 10,
    spotifyAlbumId: 'album-1',
    isrc: null,
  });

  const { works, unresolvedTracks, accounting } = await libraryOf(['track-i']);

  assert.equal(works.length, 1);
  const movements = works[0].movements;
  assert.deepEqual(
    movements.map((movement) => [movement.trackId, movement.liked, movement.missing]),
    [
      ['track-i', true, false],
      ['track-ii', false, false],
      [null, false, true],
    ],
    'the unliked movement is a real, playable track, not a missing part',
  );
  assert.equal(movements[1].uri, 'spotify:track:track-ii');
  assert.deepEqual(unresolvedTracks, [], 'an unliked album-mate is not a library gap');
  assert.deepEqual(
    accounting.map((track) => track.spotifyTrackId),
    ['track-i'],
  );
});

test('an album-mate of a work with nothing liked does not make a card', async () => {
  const { works } = await libraryOf([]);
  assert.deepEqual(works, []);
});

async function seedExtraTrack(
  id: string,
  trackNumber: number,
  recordingMbid: string,
  workMbid: string,
) {
  await db.insert(schema.spotifyTrack).values({
    spotifyId: id,
    title: id,
    trackNumber,
    discNumber: 1,
    durationMs: 100_000,
    popularity: 1,
    spotifyAlbumId: 'album-1',
    isrc: null,
  });
  await db.insert(schema.trackRecording).values({
    spotifyTrackId: id,
    recordingMbid,
    isrc: null,
    matchedBy: 'isrc',
  });
  await db.insert(schema.mbRecording).values({
    mbid: recordingMbid,
    title: `${recordingMbid} title`,
    length: 100_000,
    detail: 'full',
  });
  await db.insert(schema.mbRecordingWork).values({ recordingMbid, workMbid });
}

test('a second performance of a movement on the same album is its own card', async () => {
  await seedExtraTrack('track-i-again', 9, 'rec-i-again', 'part-i');
  const { works } = await view(['track-i', 'track-ii', 'track-i-again']);

  assert.equal(works.length, 2);
  for (const card of works) {
    const held = card.movements.filter((movement) => !movement.missing);
    assert.equal(
      new Set(held.map((movement) => movement.name)).size,
      held.length,
      'no movement is listed twice on a card',
    );
  }
});

test('a track related only to the whole work is not doubled by a missing part', async () => {
  await seedExtraTrack('track-whole', 3, 'rec-whole', 'sonata');
  const { works } = await view(['track-whole']);

  assert.equal(works.length, 1);
  assert.deepEqual(
    works[0].movements.map((movement) => [movement.name, movement.missing, movement.roman]),
    [['rec-whole title', false, '']],
    'which part it is is unknown, so no part is listed as missing and no numeral is shown',
  );
});

async function seedOtherPerformance() {
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
}

test('two performances of one work stay two cards', async () => {
  await seedOtherPerformance();

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
  await seedOtherPerformance();

  const { getMusicBrainzWorkDetail } = await import('@/lib/musicbrainz-work-page');
  const detail = await getMusicBrainzWorkDetail('sonata', null, ['track-i']);

  assert.ok(detail);
  // Fullness is a fact about what we hold, not a guess at which is better.
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
  const { getMusicBrainzWorkDetail } = await import('@/lib/musicbrainz-work-page');
  assert.equal(await getMusicBrainzWorkDetail('not-a-work', null, []), null);
});

test('a work lists every part MusicBrainz files under it, at every level, held or not', async () => {
  const sonata = 'Piano Sonata no. 16 in C major, K. 545';
  const part = (mbid: string, title: string, parentMbid: string, orderingKey: number) => ({
    mbid,
    title,
    type: null,
    parentMbid,
    orderingKey,
    composerMbid: 'mozart',
    detail: 'full' as const,
  });
  await db
    .insert(schema.mbWork)
    .values([
      part('iii-a', `${sonata}: III. Rondo: a. Theme`, 'part-iii', 1),
      part('iii-b', `${sonata}: III. Rondo: b. Coda`, 'part-iii', 2),
      part('part-iv', `${sonata}: IV. Finale`, 'sonata', 4),
      part('iv-a', `${sonata}: IV. Finale: a. Presto`, 'part-iv', 1),
    ]);
  await db
    .insert(schema.mbRecording)
    .values({ mbid: 'rec-iii-a', title: 'Theme', length: 60_000, detail: 'full' });
  await db.insert(schema.mbRecordingWork).values({ recordingMbid: 'rec-iii-a', workMbid: 'iii-a' });
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-iii-a',
    title: 'Rondo: Theme',
    trackNumber: 3,
    discNumber: 1,
    durationMs: 60_000,
    popularity: 1,
    spotifyAlbumId: 'album-1',
    isrc: 'GBAAA0000013',
  });
  await db.insert(schema.trackRecording).values({
    spotifyTrackId: 'track-iii-a',
    recordingMbid: 'rec-iii-a',
    isrc: 'GBAAA0000013',
    matchedBy: 'isrc',
  });

  const { works } = await view(['track-i', 'track-ii', 'track-iii-a']);
  assert.equal(works.length, 1);
  assert.deepEqual(
    works[0].movements.map((movement) => [
      movement.roman,
      movement.section ?? null,
      movement.name,
      movement.missing,
    ]),
    [
      ['I', null, 'Allegro', false],
      ['II', null, 'Andante', false],
      ['III', 'Rondo', 'Rondo: a. Theme', false],
      // Missing parts of a section we partly hold, and a section we hold nothing of, stay listed.
      ['III', 'Rondo', 'Rondo: b. Coda', true],
      ['IV', null, 'Finale', true],
      ['IV', 'Finale', 'Finale: a. Presto', true],
    ],
  );
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
  // MusicBrainz relates one recording to two works; it is filed under both, still one accounting
  // row.
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

test('a composer with more works than one statement can bind returns all of them', async () => {
  // More works than SQLite binds in one statement; reading one chunk would silently lose the rest.
  const total = 450;
  const works = Array.from({ length: total }, (unused, index) => ({
    mbid: `bulk-work-${index}`,
    title: `Bulk work ${index}`,
    type: 'Sonata',
    parentMbid: null,
    orderingKey: null,
    composerMbid: 'mozart',
    detail: 'full' as const,
  }));
  const recordings = works.map((work) => ({
    mbid: `bulk-rec-${work.mbid}`,
    title: work.title,
    length: 1_000,
    detail: 'full' as const,
  }));
  const tracks = works.map((work, index) => ({
    spotifyId: `bulk-track-${index}`,
    title: work.title,
    trackNumber: index + 10,
    discNumber: 1,
    durationMs: 1_000,
    popularity: null,
    spotifyAlbumId: 'album-1',
    isrc: null,
  }));
  for (let start = 0; start < total; start += 100) {
    await db.insert(schema.mbWork).values(works.slice(start, start + 100));
    await db.insert(schema.mbRecording).values(recordings.slice(start, start + 100));
    await db.insert(schema.spotifyTrack).values(tracks.slice(start, start + 100));
    await db.insert(schema.mbRecordingWork).values(
      works.slice(start, start + 100).map((work) => ({
        recordingMbid: `bulk-rec-${work.mbid}`,
        workMbid: work.mbid,
      })),
    );
    await db.insert(schema.trackRecording).values(
      tracks.slice(start, start + 100).map((track, offset) => ({
        spotifyTrackId: track.spotifyId,
        recordingMbid: `bulk-rec-bulk-work-${start + offset}`,
        isrc: null,
        matchedBy: 'isrc' as const,
      })),
    );
  }

  const { getMusicBrainzCatalogWorks, getMusicBrainzCatalogComposers } =
    await import('@/app/actions/catalog-mb');
  const listed = await getMusicBrainzCatalogWorks('mozart');
  // The fixture's own sonata is in there too.
  assert.equal(listed.length, total + 1);
  const composers = await getMusicBrainzCatalogComposers();
  assert.equal(composers.find((entry) => entry.id === 'mozart')?.workCount, total + 1);
});

test('more by the composer finds their other works, by MusicBrainz or by our own link', async () => {
  await db.insert(schema.mbWork).values([
    {
      mbid: 'fantasia',
      title: 'Fantasia in D minor, K. 397',
      type: 'Fantasia',
      parentMbid: null,
      orderingKey: null,
      composerMbid: 'mozart',
      detail: 'full',
    },
  ]);
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-fantasia',
    title: 'Fantasia in D minor',
    trackNumber: 3,
    discNumber: 1,
    durationMs: 360_000,
    popularity: 20,
    spotifyAlbumId: 'album-1',
    isrc: null,
  });
  // No MusicBrainz recording: held through our own track link.
  await db.insert(schema.trackWorkLink).values({
    spotifyTrackId: 'track-fantasia',
    workMbid: 'fantasia',
    requests: 0,
  });

  const { getMusicBrainzWorkDetail } = await import('@/lib/musicbrainz-work-page');
  const detail = await getMusicBrainzWorkDetail('sonata', null);
  assert.ok(detail);
  assert.deepEqual(
    detail.moreByComposer.map((work) => [work.workId, work.trackIds]),
    [['fantasia', ['track-fantasia']]],
    'the work itself is excluded; the other is found through the own link',
  );
});

test('a proposal stands in for a recording MusicBrainz relates to no work, unless dismissed', async () => {
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-iii',
    title: 'Piano Sonata No. 16: III. Rondo',
    trackNumber: 3,
    discNumber: 1,
    durationMs: 100_000,
    popularity: 10,
    spotifyAlbumId: 'album-1',
    isrc: 'GBAAA0000013',
  });
  await db.insert(schema.trackRecording).values({
    spotifyTrackId: 'track-iii',
    recordingMbid: 'rec-iii',
    isrc: 'GBAAA0000013',
    matchedBy: 'isrc',
  });
  await db.insert(schema.mbWorkProposal).values({
    recordingMbid: 'rec-iii',
    workMbid: 'part-iii',
    proposal: { workMbid: 'part-iii', confidence: 'medium' } as never,
    requests: 0,
  });

  const { findProviderTracksForWork } = await import('@/lib/musicbrainz-work-queries');
  const { heldWorkLinks } = await import('@/lib/db/held-work-links');
  assert.ok((await findProviderTracksForWork('sonata')).includes('track-iii'));
  assert.deepEqual(await heldWorkLinks({ tracks: ['track-iii'] }), [
    {
      spotifyTrackId: 'track-iii',
      recordingMbid: 'rec-iii',
      workMbid: 'part-iii',
      linkedBy: 'prelude',
      confidence: 'medium',
    },
  ]);

  await db
    .update(schema.mbWorkProposal)
    .set({ status: 'dismissed' })
    .where(eq(schema.mbWorkProposal.recordingMbid, 'rec-iii'));
  assert.ok(!(await findProviderTracksForWork('sonata')).includes('track-iii'));
});

test('album tracks that share a heading up to a colon are listed under it', () => {
  assert.deepEqual(
    albumSections([
      'Stabat Mater in G Minor: I. Stabat Mater',
      'Stabat Mater in G Minor: IV. Pro peccatis suae gentis',
      'Paganini: 24 Caprices, Op. 1: No. 1 in E Major',
      'Paganini: 24 Caprices, Op. 1: No. 20 in D Major',
      'Minuet in B Minor',
      'Interstellar Suite: Part 2 - Live',
      'Gladiator Suite: Part 2 - Live',
    ]),
    [
      'Stabat Mater in G Minor',
      'Stabat Mater in G Minor',
      'Paganini: 24 Caprices, Op. 1',
      'Paganini: 24 Caprices, Op. 1',
      null,
      null,
      null,
    ],
  );
});
