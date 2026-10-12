import assert from 'node:assert/strict';
import test from 'node:test';
import {
  indexWorks,
  resolveDisplayWork,
  type DisplayWorkNode,
} from '../app/lib/musicbrainz-display-work';

const node = (fields: Partial<DisplayWorkNode> & { mbid: string }): DisplayWorkNode => ({
  title: fields.mbid,
  type: null,
  parentMbid: null,
  orderingKey: null,
  composerMbid: null,
  ...fields,
});

const reference = (workMbid: string, system: string, number: string) => ({
  workMbid,
  normalizedSystem: system.toLowerCase(),
  normalizedNumber: number,
});

const SONATA = [
  node({ mbid: 'sonata', title: 'Piano Sonata', type: 'Sonata', composerMbid: 'mozart' }),
  node({
    mbid: 'allegro',
    title: 'Piano Sonata: I. Allegro',
    parentMbid: 'sonata',
    orderingKey: 1,
  }),
];

test('a movement resolves to its piece, with the piece’s composer and sorted numbers', () => {
  const resolved = resolveDisplayWork(
    'allegro',
    indexWorks(SONATA, [reference('sonata', 'K', '545'), reference('sonata', 'Anh', '1')]),
  );
  assert.equal(resolved.display?.mbid, 'sonata');
  assert.equal(resolved.composerMbid, 'mozart');
  assert.deepEqual(
    resolved.references.map((ref) => ref.normalizedSystem),
    ['anh', 'k'],
    'sorted, so every reader picks the same first number',
  );
  assert.deepEqual(
    resolved.hierarchy.map((work) => work.mbid),
    ['allegro', 'sonata'],
  );
  assert.equal(resolved.hierarchyBreak, null);
});

test('a typed work stays itself and climbs for the composer MusicBrainz files on its parent', () => {
  const resolved = resolveDisplayWork(
    'etude',
    indexWorks(
      [
        node({ mbid: 'opus', title: '12 Études', composerMbid: 'chopin' }),
        node({ mbid: 'etude', title: 'Étude in C major', type: 'Étude', parentMbid: 'opus' }),
      ],
      [],
    ),
  );
  assert.equal(resolved.display?.mbid, 'etude');
  assert.equal(resolved.composerMbid, 'chopin');
  assert.deepEqual(resolved.references, []);
});

test('a work the cache does not hold resolves to nothing rather than a guess', () => {
  const resolved = resolveDisplayWork('missing', indexWorks(SONATA, []));
  assert.equal(resolved.related, null);
  assert.equal(resolved.level, null);
  assert.equal(resolved.composerMbid, null);
});

test('reports where the climb stopped: a parent not cached, or a cycle', () => {
  const orphan = resolveDisplayWork(
    'part',
    indexWorks([node({ mbid: 'part', type: 'Sonata', parentMbid: 'gone' })], []),
  );
  assert.deepEqual(orphan.hierarchyBreak, {
    kind: 'parent-missing',
    parentMbid: 'gone',
    childMbid: 'part',
  });

  const loop = resolveDisplayWork(
    'a',
    indexWorks(
      [
        node({ mbid: 'a', type: 'Sonata', parentMbid: 'b' }),
        node({ mbid: 'b', type: 'Sonata', parentMbid: 'a' }),
      ],
      [],
    ),
  );
  assert.equal(loop.hierarchyBreak?.kind, 'cycle');
});

test('a part of a section of a Requiem resolves to the whole Requiem', () => {
  const requiem = 'Requiem in D minor, K. 626';
  const resolved = resolveDisplayWork(
    'dies-irae',
    indexWorks(
      [
        node({ mbid: 'requiem', title: requiem, type: 'Mass' }),
        node({
          mbid: 'communio',
          title: `${requiem}: VIII. Communio`,
          parentMbid: 'requiem',
          orderingKey: 7,
        }),
        node({
          mbid: 'lux',
          title: `${requiem}: VIII. Communio: a. Lux aeterna`,
          parentMbid: 'communio',
        }),
        node({
          mbid: 'sequenz',
          title: `${requiem}: III. Sequenz`,
          parentMbid: 'requiem',
          orderingKey: 3,
        }),
        node({
          mbid: 'dies-irae',
          title: `${requiem}: III. Sequenz: a. Dies irae`,
          parentMbid: 'sequenz',
          orderingKey: 1,
        }),
      ],
      [],
    ),
  );
  assert.equal(resolved.display?.mbid, 'requiem');
});

test('a prelude and fugue in a book stays itself', () => {
  const book = 'The Well-Tempered Clavier, Book I';
  const resolved = resolveDisplayWork(
    'prelude',
    indexWorks(
      [
        node({ mbid: 'book', title: book }),
        node({
          mbid: 'bwv846',
          title: `${book}: Prelude and Fugue no. 1 in C major, BWV 846`,
          parentMbid: 'book',
          orderingKey: 1,
        }),
        node({
          mbid: 'prelude',
          title: `${book}: Prelude and Fugue no. 1 in C major, BWV 846: Prelude`,
          parentMbid: 'bwv846',
          orderingKey: 1,
        }),
      ],
      [],
    ),
  );
  assert.equal(resolved.display?.mbid, 'bwv846');
});
