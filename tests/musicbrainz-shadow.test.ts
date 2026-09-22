import assert from 'node:assert/strict';
import test from 'node:test';
import { compareLibraryProjections } from '../app/lib/musicbrainz-shadow';
import type { LibraryWork, Movement } from '../app/lib/prelude';
import type { MusicBrainzLibraryProjection } from '../app/lib/musicbrainz-library';

function movement(overrides: Partial<Movement> & { trackId: string }): Movement {
  return {
    n: 1,
    position: 1,
    roman: 'I',
    name: 'Aria',
    unnamed: false,
    missing: false,
    durationMs: 200_000,
    duration: '3:20',
    liked: true,
    uri: `spotify:track:${overrides.trackId}`,
    ...overrides,
  };
}

function legacyWork(overrides: Partial<LibraryWork> & { id: string }): LibraryWork {
  return {
    workId: '1',
    recordingId: '1',
    composer: 'Bach',
    composerFull: 'Johann Sebastian Bach',
    composerId: '1',
    composerImage: null,
    era: null,
    years: '1685–1750',
    title: 'Goldberg Variations',
    nickname: null,
    catalog: 'BWV 988',
    year: 1741,
    performer: null,
    ensemble: null,
    album: 'Goldberg Variations',
    cover: null,
    tint: '#000',
    ink: '#fff',
    movements: [],
    unmatched: false,
    addedAt: null,
    gaps: [],
    ...overrides,
  };
}

function projection(
  overrides: Partial<MusicBrainzLibraryProjection>,
): MusicBrainzLibraryProjection {
  return {
    requestedTrackIds: [],
    recordings: [],
    unresolvedTracks: [],
    accounting: [],
    ...overrides,
  };
}

function heldRecording(recordingMbid: string, heldTrackIds: string[], work?: object) {
  return {
    recordingMbid,
    title: 'Aria',
    lengthMs: 200_000,
    detail: 'full' as const,
    heldTrackIds,
    works: [
      {
        relatedWorkMbid: 'work-1',
        displayWorkMbid: 'work-1',
        workLevelReason: 'no-parent' as const,
        hierarchy: [],
        title: 'Goldberg Variations',
        type: 'Theme and variations',
        catalogues: [
          {
            fromWorkMbid: 'work-1',
            seriesMbid: 'series-bwv',
            system: 'BWV',
            number: '988',
            normalizedSystem: 'bwv',
            normalizedNumber: '988',
          },
        ],
        composer: {
          mbid: 'artist-bach',
          name: 'Johann Sebastian Bach',
          creditedName: null,
          sortName: null,
          type: 'Person',
          beginYear: 1685,
          endYear: 1750,
        },
        gaps: [],
        ...work,
      },
    ],
    credits: [],
    occurrences: [],
    preferredOccurrence: null,
    gaps: [],
  };
}

test('both readers agreeing produces no differences and opens the gates', () => {
  const comparison = compareLibraryProjections(
    [legacyWork({ id: 'work-1:rec-1', movements: [movement({ trackId: 'track-1' })] })],
    projection({
      requestedTrackIds: ['track-1'],
      recordings: [heldRecording('recording-1', ['track-1'])],
      accounting: [
        {
          spotifyTrackId: 'track-1',
          status: 'ready',
          recordingMbid: 'recording-1',
          gapCodes: [],
        },
      ],
    }),
  );

  assert.deepEqual(comparison.differences, []);
  assert.deepEqual(comparison.gates, {
    everyRequestedTrackAccountedFor: true,
    noTrackDisappears: true,
  });
  assert.equal(comparison.legacyHeldCount, 1);
  assert.equal(comparison.musicBrainzHeldCount, 1);
});

test('a track the current reader shows and the new one does not closes the gate', () => {
  // This is the cutover's one hard rule: incomplete MusicBrainz coverage is
  // allowed because it is visible, but a track vanishing is not.
  const comparison = compareLibraryProjections(
    [legacyWork({ id: 'work-1:rec-1', movements: [movement({ trackId: 'track-1' })] })],
    projection({
      requestedTrackIds: ['track-1'],
      unresolvedTracks: [
        {
          spotifyTrackId: 'track-1',
          providerTitle: 'Aria',
          spotifyAlbumId: 'album-1',
          status: 'unmatched',
          classification: null,
          musicBrainz: null,
          gaps: [],
        },
      ],
      accounting: [
        {
          spotifyTrackId: 'track-1',
          status: 'unmatched',
          recordingMbid: null,
          gapCodes: ['recording-unanchored'],
        },
      ],
    }),
  );

  assert.equal(comparison.gates.noTrackDisappears, false);
  assert.deepEqual(comparison.differences, [
    {
      code: 'dropped-from-library',
      spotifyTrackIds: ['track-1'],
      legacy: 'Bach — Goldberg Variations',
      musicBrainz: null,
      gapCodes: ['recording-unanchored'],
    },
  ]);
});

test('a requested ID the projection never mentions is a fault, not a gap', () => {
  const comparison = compareLibraryProjections([], projection({ requestedTrackIds: ['track-1'] }));

  assert.equal(comparison.gates.everyRequestedTrackAccountedFor, false);
  assert.equal(comparison.differences[0].code, 'unaccounted');
});

test('reports duplicate legacy recordings collapsing into one MusicBrainz recording', () => {
  const comparison = compareLibraryProjections(
    [
      legacyWork({ id: 'work-1:rec-1', movements: [movement({ trackId: 'track-1' })] }),
      legacyWork({
        id: 'work-1:rec-2',
        recordingId: '2',
        movements: [movement({ trackId: 'track-2' })],
      }),
    ],
    projection({
      requestedTrackIds: ['track-1', 'track-2'],
      recordings: [heldRecording('recording-1', ['track-1', 'track-2'])],
      accounting: [
        { spotifyTrackId: 'track-1', status: 'ready', recordingMbid: 'recording-1', gapCodes: [] },
        { spotifyTrackId: 'track-2', status: 'ready', recordingMbid: 'recording-1', gapCodes: [] },
      ],
    }),
  );

  const merged = comparison.differences.find((item) => item.code === 'group-merged');
  assert.deepEqual(merged?.spotifyTrackIds, ['track-1', 'track-2']);
  assert.equal(merged?.legacy, 'work-1:rec-1, work-1:rec-2');
  assert.equal(merged?.musicBrainz, 'recording-1');
  // The gates do not care: merging duplicate issues is the intended change.
  assert.equal(comparison.gates.noTrackDisappears, true);
});

test('reports one legacy recording splitting across MusicBrainz recordings', () => {
  const comparison = compareLibraryProjections(
    [
      legacyWork({
        id: 'work-1:rec-1',
        movements: [movement({ trackId: 'track-1' }), movement({ trackId: 'track-2', n: 2 })],
      }),
    ],
    projection({
      requestedTrackIds: ['track-1', 'track-2'],
      recordings: [
        heldRecording('recording-1', ['track-1']),
        heldRecording('recording-2', ['track-2']),
      ],
      accounting: [
        { spotifyTrackId: 'track-1', status: 'ready', recordingMbid: 'recording-1', gapCodes: [] },
        { spotifyTrackId: 'track-2', status: 'ready', recordingMbid: 'recording-2', gapCodes: [] },
      ],
    }),
  );

  assert.equal(comparison.differenceCounts['group-split'], 1);
});

test('names the fields the two readers disagree about', () => {
  const comparison = compareLibraryProjections(
    [
      legacyWork({
        id: 'work-1:rec-1',
        title: 'Goldberg Variationen',
        composerFull: 'J. S. Bach',
        catalog: 'BWV 989',
        movements: [movement({ trackId: 'track-1' })],
      }),
    ],
    projection({
      requestedTrackIds: ['track-1'],
      recordings: [heldRecording('recording-1', ['track-1'])],
      accounting: [
        { spotifyTrackId: 'track-1', status: 'ready', recordingMbid: 'recording-1', gapCodes: [] },
      ],
    }),
  );

  assert.deepEqual(comparison.differences.map((item) => item.code).sort(), [
    'catalogue-differs',
    'composer-differs',
    'work-title-differs',
  ]);
  const catalogue = comparison.differences.find((item) => item.code === 'catalogue-differs');
  assert.equal(catalogue?.legacy, 'BWV 989');
  assert.equal(catalogue?.musicBrainz, 'BWV 988');
});

test('a ghost movement is not a track the current reader was showing', () => {
  // The legacy reader renders unsaved siblings greyed out. Counting them as
  // held would invent a regression every time MusicBrainz agreed with us.
  const comparison = compareLibraryProjections(
    [
      legacyWork({
        id: 'work-1:rec-1',
        movements: [
          movement({ trackId: 'track-1' }),
          movement({ trackId: 'track-ghost', missing: true, liked: false }),
        ],
      }),
    ],
    projection({
      requestedTrackIds: ['track-1'],
      recordings: [heldRecording('recording-1', ['track-1'])],
      accounting: [
        { spotifyTrackId: 'track-1', status: 'ready', recordingMbid: 'recording-1', gapCodes: [] },
      ],
    }),
  );

  assert.deepEqual(comparison.differences, []);
  assert.equal(comparison.legacyHeldCount, 1);
});
