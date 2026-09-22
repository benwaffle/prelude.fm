import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectMusicBrainzLibrary,
  type MusicBrainzLibraryFacts,
  type MusicBrainzGapCode,
  type TrackClassificationState,
} from '../app/lib/musicbrainz-library';

function baseFacts(): MusicBrainzLibraryFacts {
  return {
    requestedTrackIds: ['liked-1'],
    classifications: [
      {
        spotifyTrackId: 'liked-1',
        state: 'classical',
        provenance: 'musicbrainz',
        reason: 'MusicBrainz recording has a work relationship',
      },
    ],
    providerAlbums: [
      {
        spotifyAlbumId: 'album-1',
        title: 'Provider album title',
        imageUrl: 'https://example.test/cover.jpg',
        popularity: 50,
        releaseResolution: { state: 'matched', releaseMbid: 'release-1' },
      },
    ],
    providerTracks: [
      {
        spotifyTrackId: 'liked-1',
        title: 'Provider track title',
        spotifyAlbumId: 'album-1',
        discNumber: 1,
        trackNumber: 1,
        durationMs: 180_000,
        popularity: 40,
      },
    ],
    anchors: [
      {
        spotifyTrackId: 'liked-1',
        state: 'accepted',
        recordingMbid: 'recording-1',
        matchedBy: 'isrc',
        isrc: 'US-AAA-00-00001',
      },
    ],
    mbRecordings: [
      { mbid: 'recording-1', title: 'MB recording title', lengthMs: 180_000, detail: 'full' },
    ],
    mbRecordingWorks: [{ recordingMbid: 'recording-1', workMbid: 'work-1' }],
    mbWorks: [
      {
        mbid: 'work-1',
        title: 'Sonata in C major',
        type: 'Sonata',
        parentMbid: null,
        orderingKey: null,
        composerMbid: 'composer-1',
        detail: 'full',
      },
    ],
    mbWorkCatalogues: [
      {
        workMbid: 'work-1',
        seriesMbid: 'series-k',
        system: 'K.',
        number: '545',
        normalizedSystem: 'k',
        normalizedNumber: '545',
      },
    ],
    mbArtists: [
      {
        mbid: 'composer-1',
        name: 'Wolfgang Amadeus Mozart',
        creditedName: null,
        sortName: 'Mozart, Wolfgang Amadeus',
        type: 'Person',
        beginYear: 1756,
        endYear: 1791,
      },
      {
        mbid: 'performer-1',
        name: 'A Pianist',
        creditedName: 'A Pianist',
        sortName: 'Pianist, A',
        type: 'Person',
        beginYear: null,
        endYear: null,
      },
    ],
    mbRecordingCredits: [
      {
        recordingMbid: 'recording-1',
        artistMbid: 'performer-1',
        role: 'instrument',
        instrument: 'piano',
      },
    ],
    mbReleases: [
      {
        mbid: 'release-1',
        title: 'MB release title',
        date: '2020-01-01',
        country: 'US',
      },
    ],
    mbReleaseTracks: [
      {
        releaseMbid: 'release-1',
        medium: 1,
        position: 1,
        recordingMbid: 'recording-1',
        title: 'Release track title',
        lengthMs: 180_000,
      },
    ],
  };
}

function gapCodes(facts: MusicBrainzLibraryFacts): MusicBrainzGapCode[] {
  return projectMusicBrainzLibrary(facts).accounting[0].gapCodes;
}

test('projects a complete MB recording without using provider titles as classical metadata', () => {
  const result = projectMusicBrainzLibrary(baseFacts());

  assert.deepEqual(result.accounting, [
    {
      spotifyTrackId: 'liked-1',
      status: 'ready',
      recordingMbid: 'recording-1',
      gapCodes: [],
    },
  ]);
  const recording = result.recordings[0];
  assert.equal(recording.title, 'MB recording title');
  assert.equal(recording.works[0].title, 'Sonata in C major');
  assert.equal(recording.occurrences[0].providerTitle, 'Provider track title');
  assert.notEqual(recording.works[0].title, recording.occurrences[0].providerTitle);
});

test('Well-Tempered Clavier resolves a leaf to its prelude-and-fugue parent, not the book', () => {
  const facts = baseFacts();
  facts.mbRecordingWorks = [{ recordingMbid: 'recording-1', workMbid: 'wtc-prelude' }];
  facts.mbWorks = [
    {
      mbid: 'wtc-book',
      title: 'Das wohltemperierte Klavier I',
      type: null,
      parentMbid: null,
      orderingKey: null,
      composerMbid: 'composer-1',
      detail: 'full',
    },
    {
      mbid: 'wtc-pair',
      title: 'Prelude and Fugue in C major, BWV 846',
      type: 'Prelude and Fugue',
      parentMbid: 'wtc-book',
      orderingKey: 1,
      composerMbid: 'composer-1',
      detail: 'full',
    },
    {
      mbid: 'wtc-prelude',
      title: 'Prelude and Fugue in C major, BWV 846: Prelude',
      type: null,
      parentMbid: 'wtc-pair',
      orderingKey: 1,
      composerMbid: 'composer-1',
      detail: 'full',
    },
    {
      mbid: 'wtc-fugue',
      title: 'Prelude and Fugue in C major, BWV 846: Fugue',
      type: null,
      parentMbid: 'wtc-pair',
      orderingKey: 2,
      composerMbid: 'composer-1',
      detail: 'full',
    },
  ];
  facts.mbWorkCatalogues = [
    {
      workMbid: 'wtc-pair',
      seriesMbid: 'bwv',
      system: 'BWV',
      number: '846',
      normalizedSystem: 'bwv',
      normalizedNumber: '846',
    },
  ];

  const relation = projectMusicBrainzLibrary(facts).recordings[0].works[0];
  assert.equal(relation.displayWorkMbid, 'wtc-pair');
  assert.equal(relation.title, 'Prelude and Fugue in C major, BWV 846');
  assert.deepEqual(
    relation.hierarchy.map((node) => node.mbid),
    ['wtc-book', 'wtc-pair', 'wtc-prelude'],
  );
});

test('keeps every alternate Scarlatti catalogue reference from MusicBrainz', () => {
  const facts = baseFacts();
  facts.mbWorks[0] = { ...facts.mbWorks[0], title: 'Keyboard Sonata in D minor' };
  facts.mbWorkCatalogues = [
    {
      workMbid: 'work-1',
      seriesMbid: 'series-k',
      system: 'K.',
      number: '141',
      normalizedSystem: 'k',
      normalizedNumber: '141',
    },
    {
      workMbid: 'work-1',
      seriesMbid: 'series-l',
      system: 'L.',
      number: '422',
      normalizedSystem: 'l',
      normalizedNumber: '422',
    },
  ];

  assert.deepEqual(
    projectMusicBrainzLibrary(facts).recordings[0].works[0].catalogues.map(
      ({ system, number }) => `${system} ${number}`,
    ),
    ['K. 141', 'L. 422'],
  );
});

test('a film/non-classical classification remains visible and is never projected as a work', () => {
  const facts = baseFacts();
  facts.classifications[0] = {
    spotifyTrackId: 'liked-1',
    state: 'not_classical',
    provenance: 'manual',
    reason: 'reviewed film score',
  };

  const result = projectMusicBrainzLibrary(facts);
  assert.equal(result.recordings.length, 0);
  assert.equal(result.unresolvedTracks[0].status, 'unclassified');
  assert.deepEqual(result.accounting[0].gapCodes, ['classification-not-classical']);
});

test('a combined-movement recording preserves all MB work relationships', () => {
  const facts = baseFacts();
  facts.mbRecordingWorks.push({ recordingMbid: 'recording-1', workMbid: 'work-2' });
  facts.mbWorks.push({
    mbid: 'work-2',
    title: 'Finale',
    type: 'Movement',
    parentMbid: null,
    orderingKey: 2,
    composerMbid: 'composer-1',
    detail: 'full',
  });
  facts.mbWorkCatalogues.push({
    workMbid: 'work-2',
    seriesMbid: 'series-k',
    system: 'K.',
    number: '545/3',
    normalizedSystem: 'k',
    normalizedNumber: '545/3',
  });

  const works = projectMusicBrainzLibrary(facts).recordings[0].works;
  assert.deepEqual(
    works.map((work) => work.relatedWorkMbid),
    ['work-1', 'work-2'],
  );
});

test('duplicate Spotify releases coalesce under one MB recording and prefer a held occurrence', () => {
  const facts = baseFacts();
  facts.providerAlbums.push({
    spotifyAlbumId: 'album-2',
    title: 'Another provider issue',
    imageUrl: null,
    popularity: 99,
    releaseResolution: { state: 'matched', releaseMbid: 'release-2' },
  });
  facts.providerTracks.push({
    spotifyTrackId: 'alternate-1',
    title: 'Same performance elsewhere',
    spotifyAlbumId: 'album-2',
    discNumber: 1,
    trackNumber: 1,
    durationMs: 180_000,
    popularity: 99,
  });
  facts.anchors.push({
    spotifyTrackId: 'alternate-1',
    state: 'accepted',
    recordingMbid: 'recording-1',
    matchedBy: 'isrc',
    isrc: 'US-AAA-00-00001',
  });
  facts.mbReleases.push({
    mbid: 'release-2',
    title: 'Another MB release',
    date: '2022',
    country: 'GB',
  });
  facts.mbReleaseTracks.push({
    releaseMbid: 'release-2',
    medium: 1,
    position: 1,
    recordingMbid: 'recording-1',
    title: 'Same performance elsewhere',
    lengthMs: 180_000,
  });

  const result = projectMusicBrainzLibrary(facts);
  assert.equal(result.recordings.length, 1);
  assert.equal(result.recordings[0].occurrences.length, 2);
  assert.equal(result.recordings[0].preferredOccurrence?.spotifyTrackId, 'liked-1');
});

test('a recording with no work relation remains accounted as incomplete', () => {
  const facts = baseFacts();
  facts.mbRecordingWorks = [];

  const result = projectMusicBrainzLibrary(facts);
  assert.equal(result.recordings.length, 1);
  assert.equal(result.accounting[0].status, 'incomplete');
  assert.ok(result.accounting[0].gapCodes.includes('recording-work-missing'));
});

test('a stub with a missing parent exposes both cache and hierarchy gaps', () => {
  const facts = baseFacts();
  facts.mbWorks[0] = {
    ...facts.mbWorks[0],
    detail: 'stub',
    type: null,
    parentMbid: 'missing-parent',
  };
  facts.mbWorkCatalogues = [];

  const codes = gapCodes(facts);
  assert.ok(codes.includes('work-stub'));
  assert.ok(codes.includes('work-hierarchy-parent-missing'));
  assert.ok(codes.includes('work-level-ambiguous'));
});

test('conflicting ISRC/position evidence is not promoted to a recording', () => {
  const facts = baseFacts();
  facts.anchors[0] = {
    spotifyTrackId: 'liked-1',
    state: 'conflicting',
    candidateRecordingMbids: ['recording-isrc', 'recording-position'],
    reason: 'ISRC and verified release position disagree',
  };

  const result = projectMusicBrainzLibrary(facts);
  assert.equal(result.recordings.length, 0);
  assert.equal(result.accounting[0].status, 'unmatched');
  assert.deepEqual(result.accounting[0].gapCodes, ['recording-anchor-conflict']);
});

test('every requested track ID is accounted for exactly once across all states', () => {
  const facts = baseFacts();
  facts.requestedTrackIds = ['liked-1', 'unanchored', 'uncertain', 'not-fetched', 'liked-1'];
  facts.providerTracks.push(
    {
      spotifyTrackId: 'unanchored',
      title: 'Known provider track',
      spotifyAlbumId: 'album-1',
      discNumber: 1,
      trackNumber: 2,
      durationMs: 100_000,
      popularity: null,
    },
    {
      spotifyTrackId: 'uncertain',
      title: 'Maybe classical',
      spotifyAlbumId: 'album-1',
      discNumber: 1,
      trackNumber: 3,
      durationMs: 100_000,
      popularity: null,
    },
  );
  facts.classifications.push(
    {
      spotifyTrackId: 'unanchored',
      state: 'classical',
      provenance: 'manual',
      reason: null,
    },
    {
      spotifyTrackId: 'uncertain',
      state: 'uncertain',
      provenance: 'llm_proposal',
      reason: 'classification needs review',
    },
  );

  const result = projectMusicBrainzLibrary(facts);
  assert.deepEqual(result.requestedTrackIds, ['liked-1', 'unanchored', 'uncertain', 'not-fetched']);
  assert.deepEqual(
    result.accounting.map((item) => item.spotifyTrackId),
    result.requestedTrackIds,
  );
  assert.equal(new Set(result.accounting.map((item) => item.spotifyTrackId)).size, 4);
  assert.deepEqual(
    result.accounting.map((item) => item.status),
    ['ready', 'unmatched', 'unclassified', 'unmatched'],
  );
});

/** Adds a second liked track anchored to the same MusicBrainz recording. */
function addSecondHolding(facts: MusicBrainzLibraryFacts, state: TrackClassificationState) {
  facts.requestedTrackIds.push('liked-2');
  facts.classifications.push({
    spotifyTrackId: 'liked-2',
    state,
    provenance: state === 'not_classical' ? 'manual' : 'llm_proposal',
    reason: 'reviewed by hand',
  });
  facts.providerTracks.push({
    spotifyTrackId: 'liked-2',
    title: 'Provider track title',
    spotifyAlbumId: 'album-1',
    discNumber: 1,
    trackNumber: 2,
    durationMs: 180_000,
    popularity: 40,
  });
  facts.anchors.push({
    spotifyTrackId: 'liked-2',
    state: 'accepted',
    recordingMbid: 'recording-1',
    matchedBy: 'isrc',
    isrc: 'US-AAA-00-00001',
  });
}

test('a track ruled not classical stays in its bucket even when its recording is projected', () => {
  // Sharing a recording with a track that did resolve must not drag a track
  // we deliberately set aside back into the classical projection.
  const facts = baseFacts();
  addSecondHolding(facts, 'not_classical');

  const result = projectMusicBrainzLibrary(facts);
  assert.deepEqual(result.recordings[0].heldTrackIds, ['liked-1']);
  assert.deepEqual(
    result.unresolvedTracks.map((track) => track.spotifyTrackId),
    ['liked-2'],
  );
  const accounted = result.accounting.find((track) => track.spotifyTrackId === 'liked-2');
  assert.equal(accounted?.status, 'unclassified');
  assert.equal(accounted?.recordingMbid, null);
  assert.deepEqual(accounted?.gapCodes, ['classification-not-classical']);
  // It is still listed as a provider occurrence, so the alternative is not
  // lost — it is simply not held.
  const occurrence = result.recordings[0].occurrences.find(
    (candidate) => candidate.spotifyTrackId === 'liked-2',
  );
  assert.equal(occurrence?.held, false);
});

test('an uncertain classification is not resolved by a neighbouring track', () => {
  const facts = baseFacts();
  addSecondHolding(facts, 'uncertain');

  const result = projectMusicBrainzLibrary(facts);
  assert.deepEqual(result.recordings[0].heldTrackIds, ['liked-1']);
  const accounted = result.accounting.find((track) => track.spotifyTrackId === 'liked-2');
  assert.equal(accounted?.status, 'unclassified');
  assert.deepEqual(accounted?.gapCodes, ['classification-uncertain']);
});

test('an uncached recording says its detail is unknown rather than calling it a stub', () => {
  const facts = baseFacts();
  facts.mbRecordings = [];

  const result = projectMusicBrainzLibrary(facts);
  assert.equal(result.recordings[0].detail, null);
  assert.equal(result.recordings[0].title, null);
  assert.ok(result.accounting[0].gapCodes.includes('recording-cache-missing'));
});

test('an unfetched provider album leaves the occurrence title blank, not empty-looking', () => {
  const facts = baseFacts();
  facts.providerAlbums = [];

  const result = projectMusicBrainzLibrary(facts);
  const occurrence = result.recordings[0].occurrences[0];
  assert.equal(occurrence.providerAlbumTitle, null);
  assert.ok(occurrence.gaps.some((item) => item.code === 'provider-album-not-fetched'));
});
