import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cataloguesOf,
  childPartsOf,
  composerOf,
  parentWorkOf,
  resolveWorkLevel,
  stripParentPrefix,
  yearOf,
  type MbWork,
} from '../app/lib/musicbrainz';
import { titlesAreCompatible } from '../app/lib/metadata-matching';

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

test('a multi-movement work resolves to the parent its movements share', () => {
  // A symphony: every movement is a leaf under one work.
  const parts = [
    { leafId: 'mvt1', parentId: 'sym', title: 'I. Allegro' },
    { leafId: 'mvt2', parentId: 'sym', title: 'II. Andante' },
    { leafId: 'mvt3', parentId: 'sym', title: 'III. Scherzo' },
  ];
  assert.equal(resolveWorkLevel('Symphony no. 5', parts, titlesAreCompatible), 'sym');
});

test('a work matched at two depths resolves to the lower of them', () => {
  // Real case: our "Prelude and Fugue No. 2" has tracks of the prelude and the
  // fugue separately, and tracks of the whole thing. The whole-work tracks sit
  // under The Well-Tempered Clavier, so taking the parent would file us there.
  const parts = [
    { leafId: 'prelude', parentId: 'pf2', title: 'Prelude' },
    { leafId: 'fugue', parentId: 'pf2', title: 'Fugue' },
    { leafId: 'pf2', parentId: 'wtc-book-1', title: 'Prelude and Fugue no. 2 in C minor' },
    { leafId: 'pf2', parentId: 'wtc-book-1', title: 'Prelude and Fugue no. 2 in C minor' },
  ];
  assert.equal(
    resolveWorkLevel('Prelude and Fugue No. 2 in C Minor', parts, titlesAreCompatible),
    'pf2',
  );
});

test('a single-part work is the piece itself when the titles agree', () => {
  // A film cue is a work for us and a part of the soundtrack for MusicBrainz.
  // Ours is the cue, so the cue is what we link to.
  const parts = [{ leafId: 'black-pearl', parentId: 'potc-soundtrack', title: 'The Black Pearl' }];
  assert.equal(resolveWorkLevel('The Black Pearl', parts, titlesAreCompatible), 'black-pearl');
});

test('a single part that is plainly a movement resolves to the parent', () => {
  // We hold one movement of a larger work; the work is what we mean.
  const parts = [{ leafId: 'mvt2', parentId: 'concerto', title: 'II. Adagio' }];
  assert.equal(
    resolveWorkLevel('Violin Concerto in A minor', parts, titlesAreCompatible),
    'concerto',
  );
});

test('records nothing when parts name unrelated works', () => {
  const parts = [
    { leafId: 'a', parentId: 'work-a', title: 'I' },
    { leafId: 'b', parentId: 'work-b', title: 'II' },
  ];
  assert.equal(resolveWorkLevel('Something', parts, titlesAreCompatible), null);
});

test('records nothing for a single part with no parent and no title agreement', () => {
  const parts = [{ leafId: 'solo', parentId: 'solo', title: 'Completely Different' }];
  assert.equal(resolveWorkLevel('Our Title', parts, titlesAreCompatible), null);
});

test('one badly matched part does not break an otherwise unanimous work', () => {
  // Haydn's Symphony 87: three movements agree, and the finale matched
  // Symphony 82's recording because MusicBrainz carries a Sony ISRC that the
  // label attached to the wrong work.
  const parts = [
    { leafId: 'm1', parentId: 'sym87', title: 'I. Vivace' },
    { leafId: 'm2', parentId: 'sym87', title: 'II. Adagio' },
    { leafId: 'm3', parentId: 'sym87', title: 'III. Menuet' },
    { leafId: 'wrong', parentId: 'sym82', title: 'IV. Finale. Vivace' },
  ];
  assert.equal(resolveWorkLevel('Symphony No. 87 in A major', parts, titlesAreCompatible), 'sym87');
});

test('an even split stays unresolved', () => {
  // Two against two is a real question, not an outlier to discard.
  const parts = [
    { leafId: 'a1', parentId: 'workA', title: 'I' },
    { leafId: 'a2', parentId: 'workA', title: 'II' },
    { leafId: 'b1', parentId: 'workB', title: 'III' },
    { leafId: 'b2', parentId: 'workB', title: 'IV' },
  ];
  assert.equal(resolveWorkLevel('Something', parts, titlesAreCompatible), null);
});

test('a single dissenting part out of two is not a majority', () => {
  const parts = [
    { leafId: 'a', parentId: 'workA', title: 'I' },
    { leafId: 'b', parentId: 'workB', title: 'II' },
  ];
  assert.equal(resolveWorkLevel('Something', parts, titlesAreCompatible), null);
});

test('our parts subdividing one MusicBrainz work resolve to that work', () => {
  // We store a prelude and its fugue as two movements; MusicBrainz keeps the
  // pair as one work inside "8 kleine Präludien und Fugen, BWV 553-560".
  // Reaching for the parent would make all eight resolve to the collection,
  // and so to each other.
  const parts = [
    { leafId: 'pf-d-minor', parentId: 'eight-short', title: 'Prelude' },
    { leafId: 'pf-d-minor', parentId: 'eight-short', title: 'Fugue' },
  ];
  assert.equal(
    resolveWorkLevel('Prelude and Fugue in D Minor', parts, titlesAreCompatible),
    'pf-d-minor',
  );
});

test('a lone movement of a larger work still resolves to the work', () => {
  // One part only, so it is a movement we hold in isolation, not a work
  // MusicBrainz declines to subdivide.
  const parts = [{ leafId: 'mvt2', parentId: 'concerto', title: 'II. Adagio' }];
  assert.equal(
    resolveWorkLevel('Violin Concerto in A minor', parts, titlesAreCompatible),
    'concerto',
  );
});
