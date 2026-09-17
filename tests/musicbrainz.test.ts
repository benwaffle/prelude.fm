import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cataloguesOf,
  childPartsOf,
  composerOf,
  parentWorkOf,
  stripParentPrefix,
  yearOf,
  type MbWork,
} from '../app/lib/musicbrainz';

const bwv1067: MbWork = {
  id: '179cc1f2-1135-4619-85f0-e42cd9d00979',
  title: 'Orchestersuite Nr. 2 h-Moll, BWV 1067',
  type: 'Suite',
  relations: [
    {
      type: 'composer',
      direction: 'backward',
      artist: { id: 'artist-bach', name: 'Johann Sebastian Bach' },
    },
    {
      type: 'part of',
      direction: 'backward',
      series: { id: 'series-bwv', name: 'Bach-Werke-Verzeichnis', type: 'Catalogue' },
      'attribute-values': { number: 'BWV 1067' },
    },
    {
      // A numbered *work* series, not a catalogue. Reading this as a catalogue
      // number would file the second suite under catalogue number "2".
      type: 'part of',
      direction: 'backward',
      series: { id: 'series-suites', name: 'Orchestersuiten', type: 'Work series' },
      'attribute-values': { number: '2' },
    },
    {
      type: 'parts',
      direction: 'forward',
      work: { id: 'leaf-1', title: 'Orchestersuite Nr. 2 h-Moll, BWV 1067: I. Ouverture' },
    },
    { type: 'parts', direction: 'backward', work: { id: 'parent-x', title: 'Orchestersuiten' } },
  ],
};

test('reads only catalogue series as catalogue numbers', () => {
  const catalogues = cataloguesOf(bwv1067);
  assert.deepEqual(catalogues, [
    { seriesId: 'series-bwv', system: 'Bach-Werke-Verzeichnis', number: 'BWV 1067' },
  ]);
});

test('ignores a catalogue relation with no number', () => {
  const work: MbWork = {
    id: 'w',
    title: 'w',
    relations: [
      {
        type: 'part of',
        direction: 'backward',
        series: { id: 's', name: 'Some catalogue', type: 'Catalogue' },
      },
    ],
  };
  assert.deepEqual(cataloguesOf(work), []);
});

test('separates parent from child part relations by direction', () => {
  assert.equal(parentWorkOf(bwv1067)?.id, 'parent-x');
  assert.deepEqual(
    childPartsOf(bwv1067).map((p) => p.id),
    ['leaf-1'],
  );
});

test('reads the composer relation', () => {
  assert.equal(composerOf(bwv1067)?.name, 'Johann Sebastian Bach');
  assert.equal(composerOf({ id: 'w', title: 'w', relations: [] }), null);
});

test('strips the parent title from a movement title', () => {
  assert.equal(
    stripParentPrefix(
      'Orchestersuite Nr. 2 h-Moll, BWV 1067: IV. Bourrée I/II',
      'Orchestersuite Nr. 2 h-Moll, BWV 1067',
    ),
    'IV. Bourrée I/II',
  );
});

test('leaves a title alone when the parent prefix does not match exactly', () => {
  assert.equal(
    stripParentPrefix('Sonata in A: I. Allegro', 'Sonata in B'),
    'Sonata in A: I. Allegro',
  );
  assert.equal(stripParentPrefix('Canzonetta, op. 62a', null), 'Canzonetta, op. 62a');
});

test('never returns an empty movement title', () => {
  assert.equal(stripParentPrefix('Requiem:', 'Requiem'), 'Requiem:');
});

test('reads a year from a MusicBrainz life-span date', () => {
  assert.equal(yearOf('1845-05-12'), 1845);
  assert.equal(yearOf('1845'), 1845);
  assert.equal(yearOf(null), null);
  assert.equal(yearOf(''), null);
});
