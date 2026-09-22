import assert from 'node:assert/strict';
import test from 'node:test';
import { shapeHeldCatalogue, type CatalogueWorkNode } from '../app/lib/musicbrainz-catalogue-shape';

const GOLDBERG: CatalogueWorkNode[] = [
  {
    mbid: 'goldberg',
    title: 'Goldberg Variations, BWV 988',
    type: 'Theme and variations',
    parentMbid: null,
    orderingKey: null,
    composerMbid: 'bach',
  },
  {
    mbid: 'aria',
    title: 'Goldberg Variations, BWV 988: Aria',
    type: null,
    parentMbid: 'goldberg',
    orderingKey: 1,
    composerMbid: null,
  },
];

test('files a movement under the piece a reader would name', () => {
  const [shaped] = shapeHeldCatalogue([{ recordingMbid: 'rec-1', workMbid: 'aria' }], GOLDBERG, [
    { workMbid: 'goldberg', system: 'BWV', number: '988' },
  ]);

  assert.equal(shaped.mbid, 'goldberg');
  assert.deepEqual(shaped.reference, { workMbid: 'goldberg', system: 'BWV', number: '988' });
  assert.equal(shaped.composerMbid, 'bach');
});

test('keeps a typed work as itself and still finds its catalogue above it', () => {
  // The library shows an étude as an étude; the catalogue must agree, or a
  // card's catalogue number would lead to a work the catalogue never lists.
  const [shaped] = shapeHeldCatalogue(
    [{ recordingMbid: 'rec-1', workMbid: 'etude-1' }],
    [
      {
        mbid: 'opus-10',
        title: '12 Études, op. 10',
        type: 'Étude',
        parentMbid: null,
        orderingKey: null,
        composerMbid: 'chopin',
      },
      {
        mbid: 'etude-1',
        title: 'Étude in C major',
        type: 'Étude',
        parentMbid: 'opus-10',
        orderingKey: 1,
        composerMbid: null,
      },
    ],
    [{ workMbid: 'opus-10', system: 'Op.', number: '10' }],
  );

  assert.equal(shaped.mbid, 'etude-1');
  assert.equal(shaped.reference?.number, '10');
  assert.equal(shaped.composerMbid, 'chopin');
});

test('gathers every recording of one work into one row', () => {
  const shaped = shapeHeldCatalogue(
    [
      { recordingMbid: 'rec-1', workMbid: 'aria' },
      { recordingMbid: 'rec-2', workMbid: 'aria' },
      { recordingMbid: 'rec-2', workMbid: 'aria' },
    ],
    GOLDBERG,
    [],
  );

  assert.equal(shaped.length, 1);
  assert.deepEqual(shaped[0].recordingMbids, ['rec-1', 'rec-2']);
  assert.equal(shaped[0].reference, null, 'no catalogue anywhere above it is null, not invented');
});

test('a work MusicBrainz has not cached is left out rather than guessed at', () => {
  assert.deepEqual(
    shapeHeldCatalogue([{ recordingMbid: 'rec-1', workMbid: 'never-fetched' }], GOLDBERG, []),
    [],
  );
});
