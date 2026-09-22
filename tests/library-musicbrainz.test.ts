import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import { projectMusicBrainzLibrary } from '../app/lib/musicbrainz-library';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let loadMusicBrainzLibraryFacts: typeof import('@/app/actions/library-musicbrainz').loadMusicBrainzLibraryFacts;

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  ({ loadMusicBrainzLibraryFacts } = await import('@/app/actions/library-musicbrainz'));
});

/**
 * One performance (recording-1) issued on two Spotify albums, of a work that
 * is a part of a larger work, plus a track the parser set aside and a track
 * whose ISRC names two recordings.
 */
async function seedLibrary() {
  await db.insert(schema.spotifyAlbum).values([
    {
      spotifyId: 'album-1',
      title: 'Goldberg Variations',
      year: 1981,
      popularity: 55,
      images: [{ url: 'https://example.test/1.jpg', width: 640, height: 640 }],
      upc: '0000000000001',
      mbReleaseId: 'release-1',
      mbReleaseCandidates: 1,
      mbCheckedAt: new Date('2026-01-01'),
    },
    {
      spotifyId: 'album-2',
      title: 'Bach Reissue',
      year: 2005,
      popularity: 20,
      images: null,
      upc: '0000000000002',
      mbReleaseId: null,
      mbReleaseCandidates: 3,
      mbCheckedAt: new Date('2026-01-01'),
    },
    {
      spotifyId: 'album-3',
      title: 'Film Score',
      year: 2011,
      popularity: 70,
      images: null,
      upc: null,
      mbReleaseId: null,
      mbReleaseCandidates: null,
      mbCheckedAt: null,
    },
  ]);
  await db.insert(schema.spotifyTrack).values([
    {
      spotifyId: 'held-1',
      title: 'Aria',
      trackNumber: 1,
      discNumber: 1,
      durationMs: 200_000,
      popularity: 61,
      spotifyAlbumId: 'album-1',
      isrc: 'GBAAA0000001',
    },
    {
      spotifyId: 'reissue-1',
      title: 'Aria (remastered)',
      trackNumber: 1,
      discNumber: 1,
      durationMs: 200_000,
      popularity: 12,
      spotifyAlbumId: 'album-2',
      isrc: 'GBAAA0000001',
    },
    {
      spotifyId: 'held-2',
      title: 'Main Titles',
      trackNumber: 4,
      discNumber: 1,
      durationMs: 120_000,
      popularity: 80,
      spotifyAlbumId: 'album-3',
      isrc: null,
    },
    {
      spotifyId: 'held-3',
      title: 'Symphony No. 87',
      trackNumber: 2,
      discNumber: 1,
      durationMs: 300_000,
      popularity: 5,
      spotifyAlbumId: 'album-3',
      isrc: 'GBAAA0000009',
    },
  ]);
  await db.insert(schema.trackRecording).values([
    {
      spotifyTrackId: 'held-1',
      recordingMbid: 'recording-1',
      isrc: 'GBAAA0000001',
      matchedBy: 'isrc',
    },
    {
      spotifyTrackId: 'reissue-1',
      recordingMbid: 'recording-1',
      isrc: null,
      matchedBy: 'release_position',
    },
  ]);
  await db.insert(schema.mbRecording).values({
    mbid: 'recording-1',
    title: 'Aria',
    length: 200_000,
    detail: 'full',
  });
  await db.insert(schema.mbRecordingWork).values({
    recordingMbid: 'recording-1',
    workMbid: 'work-aria',
  });
  await db.insert(schema.mbWork).values([
    {
      mbid: 'work-aria',
      title: 'Goldberg Variations, BWV 988: Aria',
      type: null,
      parentMbid: 'work-goldberg',
      orderingKey: 1,
      composerMbid: 'artist-bach',
      detail: 'full',
    },
    {
      mbid: 'work-goldberg',
      title: 'Goldberg Variations, BWV 988',
      type: 'Theme and variations',
      parentMbid: null,
      orderingKey: null,
      composerMbid: 'artist-bach',
      detail: 'full',
    },
  ]);
  await db.insert(schema.mbWorkCatalogue).values({
    workMbid: 'work-goldberg',
    seriesMbid: 'series-bwv',
    system: 'BWV',
    number: '988',
    normalizedSystem: 'bwv',
    normalizedNumber: '988',
  });
  await db.insert(schema.mbArtist).values([
    {
      mbid: 'artist-bach',
      name: 'Johann Sebastian Bach',
      creditedName: null,
      sortName: 'Bach, Johann Sebastian',
      type: 'Person',
      beginYear: 1685,
      endYear: 1750,
    },
    {
      mbid: 'artist-gould',
      name: 'Glenn Gould',
      creditedName: 'Glenn Gould',
      sortName: 'Gould, Glenn',
      type: 'Person',
      beginYear: 1932,
      endYear: 1982,
    },
  ]);
  await db.insert(schema.mbRecordingCredit).values({
    recordingMbid: 'recording-1',
    artistMbid: 'artist-gould',
    role: 'instrument',
    instrument: 'piano',
  });
  await db.insert(schema.mbRelease).values({
    mbid: 'release-1',
    title: 'Goldberg Variations',
    barcode: '0000000000001',
    date: '1981-09-01',
    country: 'US',
  });
  await db.insert(schema.mbReleaseTrack).values({
    releaseMbid: 'release-1',
    medium: 1,
    position: 1,
    recordingMbid: 'recording-1',
    title: 'Aria',
    length: 200_000,
  });
  // The parser set this one aside, and nothing in MusicBrainz contradicts it.
  await db.insert(schema.matchQueue).values({
    spotifyId: 'held-2',
    spotifyAlbumId: 'album-3',
    submittedBy: 'test',
    status: 'not_classical',
  });
  // One ISRC, two recordings: the Symphony 87 contradiction.
  await db.insert(schema.mbRecordingIsrc).values([
    { isrc: 'GBAAA0000009', recordingMbid: 'recording-87a' },
    { isrc: 'GBAAA0000009', recordingMbid: 'recording-87b' },
  ]);
  await db.insert(schema.mbRecordingWork).values([
    { recordingMbid: 'recording-87a', workMbid: 'work-87' },
    { recordingMbid: 'recording-87b', workMbid: 'work-87' },
  ]);
}

beforeEach(async () => {
  await resetTestDatabase(db);
  await seedLibrary();
});

test('reads the anchored recording with its work tree, catalogue and credits', async () => {
  const facts = await loadMusicBrainzLibraryFacts(['held-1']);

  assert.deepEqual(facts.mbRecordings, [
    { mbid: 'recording-1', title: 'Aria', lengthMs: 200_000, detail: 'full' },
  ]);
  assert.deepEqual(
    facts.mbWorks.map((work) => work.mbid).sort(),
    ['work-aria', 'work-goldberg'],
    'the parent is walked, not just the related work',
  );
  assert.deepEqual(
    facts.mbWorkCatalogues.map((catalogue) => catalogue.number),
    ['988'],
  );
  assert.deepEqual(
    facts.mbArtists.map((artist) => artist.mbid).sort(),
    ['artist-bach', 'artist-gould'],
    'the composer and the performer both come from mb_artist',
  );
  assert.deepEqual(facts.mbRecordingCredits, [
    {
      recordingMbid: 'recording-1',
      artistMbid: 'artist-gould',
      role: 'instrument',
      instrument: 'piano',
    },
  ]);
  assert.equal(facts.mbReleases[0].date, '1981-09-01');
  assert.equal(facts.mbReleaseTracks[0].position, 1);
});

test('brings in the other Spotify issue of the same performance', async () => {
  const facts = await loadMusicBrainzLibraryFacts(['held-1']);

  assert.deepEqual(facts.providerTracks.map((track) => track.spotifyTrackId).sort(), [
    'held-1',
    'reissue-1',
  ]);
  const projection = projectMusicBrainzLibrary(facts);
  assert.equal(projection.recordings.length, 1);
  assert.deepEqual(projection.recordings[0].heldTrackIds, ['held-1']);
  assert.equal(projection.recordings[0].occurrences.length, 2);
  // The reissue is a real alternative, not a second holding.
  assert.deepEqual(projection.accounting, [
    {
      spotifyTrackId: 'held-1',
      status: 'ready',
      recordingMbid: 'recording-1',
      gapCodes: [],
    },
  ]);
});

test('states each album release resolution from what was actually checked', async () => {
  const facts = await loadMusicBrainzLibraryFacts(['held-1', 'held-2', 'held-3']);
  const resolutionOf = (id: string) =>
    facts.providerAlbums.find((album) => album.spotifyAlbumId === id)?.releaseResolution;

  assert.deepEqual(resolutionOf('album-1'), { state: 'matched', releaseMbid: 'release-1' });
  assert.deepEqual(resolutionOf('album-2'), { state: 'ambiguous', candidateMbids: [] });
  assert.deepEqual(resolutionOf('album-3'), { state: 'not_checked' });
});

test('labels the parser verdict as a proposal and lets MusicBrainz outrank it', async () => {
  const facts = await loadMusicBrainzLibraryFacts(['held-1', 'held-2']);
  const classificationOf = (id: string) =>
    facts.classifications.find((item) => item.spotifyTrackId === id);

  assert.equal(classificationOf('held-2')?.state, 'not_classical');
  assert.equal(classificationOf('held-2')?.provenance, 'llm_proposal');
  assert.equal(classificationOf('held-1')?.state, 'classical');
  assert.equal(classificationOf('held-1')?.provenance, 'musicbrainz');

  // MusicBrainz relating the recording to a work is deterministic evidence
  // and outranks the parser, but the disagreement is stated, not buried.
  await db.insert(schema.matchQueue).values({
    spotifyId: 'held-1',
    spotifyAlbumId: 'album-1',
    submittedBy: 'test',
    status: 'not_classical',
  });
  const reread = await loadMusicBrainzLibraryFacts(['held-1']);
  assert.equal(reread.classifications[0].state, 'classical');
  assert.match(reread.classifications[0].reason ?? '', /parser ruled this not classical/);
});

test('an ISRC naming two recordings is reported as a conflict, not anchored', async () => {
  const facts = await loadMusicBrainzLibraryFacts(['held-3']);

  assert.deepEqual(facts.anchors, [
    {
      spotifyTrackId: 'held-3',
      state: 'conflicting',
      candidateRecordingMbids: ['recording-87a', 'recording-87b'],
      reason: 'ISRC GBAAA0000009 names 2 MusicBrainz recordings',
    },
  ]);
  const projection = projectMusicBrainzLibrary(facts);
  assert.equal(projection.recordings.length, 0);
  assert.equal(projection.accounting[0].status, 'unmatched');
  assert.deepEqual(projection.accounting[0].gapCodes, ['recording-anchor-conflict']);
});

test('accounts for every held track exactly once, ready or not', async () => {
  const requested = ['held-1', 'held-2', 'held-3', 'never-fetched'];
  const facts = await loadMusicBrainzLibraryFacts(requested);
  const projection = projectMusicBrainzLibrary(facts);

  assert.deepEqual(
    projection.accounting.map((track) => track.spotifyTrackId),
    requested,
  );
  assert.deepEqual(
    projection.accounting.map((track) => track.status),
    ['ready', 'unclassified', 'unmatched', 'unmatched'],
  );
  assert.deepEqual(
    projection.accounting.find((track) => track.spotifyTrackId === 'never-fetched')?.gapCodes,
    ['provider-track-not-fetched'],
  );
});

test('reads a library larger than SQLite will bind in one statement', async () => {
  const requested = [
    'held-1',
    ...Array.from({ length: 1_200 }, (unused, index) => `absent-${index}`),
  ];
  const facts = await loadMusicBrainzLibraryFacts(requested);

  assert.equal(facts.requestedTrackIds.length, 1_201);
  assert.equal(projectMusicBrainzLibrary(facts).accounting.length, 1_201);
});
