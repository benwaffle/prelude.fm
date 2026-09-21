import assert from 'node:assert/strict';
import test from 'node:test';
import { workLevelOf, type WorkNode } from '../app/lib/musicbrainz-work-level';

function node(partial: Partial<WorkNode>): WorkNode {
  return {
    mbid: 'self',
    title: 'A Work',
    type: null,
    parentMbid: null,
    parentTitle: null,
    hasChildren: false,
    ...partial,
  };
}

test('a movement titled after its parent belongs to the parent', () => {
  const level = workLevelOf(
    node({
      title: 'Concerto for 2 Violins in A minor, RV 523: I. Allegro molto',
      parentMbid: 'concerto',
      parentTitle: 'Concerto for 2 Violins in A minor, RV 523',
    }),
  );
  assert.equal(level.mbid, 'concerto');
  assert.equal(level.reason, 'titled-as-part');
});

test('a work with parts is the work, not one of its parts', () => {
  // "Prelude and Fugue No. 1" is untyped and sits inside the book, but it has
  // a prelude and a fugue under it, so it is the piece.
  const level = workLevelOf(
    node({
      title: 'Prelude and Fugue in C major, BWV 846',
      parentMbid: 'wtc-1',
      parentTitle: 'Das wohltemperierte Klavier I',
      hasChildren: true,
    }),
  );
  assert.equal(level.mbid, 'self');
  assert.equal(level.reason, 'has-parts');
});

test('a typed work stays itself however deeply it is filed', () => {
  // All 24 cached études have a parent and no children. Climbing to the
  // parent would file every one of them under "12 Études, Op. 10" and make
  // them indistinguishable from each other.
  const level = workLevelOf(
    node({
      title: '12 Études, op. 10: no. 11 in E-flat major',
      type: 'Étude',
      parentMbid: 'etudes-10',
      parentTitle: '12 Études, op. 10',
    }),
  );
  assert.equal(level.mbid, 'self');
  assert.equal(level.reason, 'typed');
});

test('a piece in a collection is left alone rather than merged into it', () => {
  // The expensive mistake runs this way: collapsing distinct pieces into
  // their collection looks plausible afterwards and cannot be undone by
  // inspection.
  const level = workLevelOf(
    node({
      title: 'Mazurka no. 23 in D major, op. 33 no. 2',
      parentMbid: 'mazurkas-33',
      parentTitle: 'Mazurkas, op. 33',
    }),
  );
  assert.equal(level.mbid, 'self');
  assert.equal(level.reason, 'unresolved');
  assert.equal(level.needsReview, true);
});

test('an unsettled case is reported rather than guessed', () => {
  // A real movement whose parent is titled differently lands here too, and
  // loses its grouping. That is the cheaper of the two errors, but it is
  // still an error, so it is flagged rather than hidden.
  const level = workLevelOf(
    node({
      title: 'Trio Sonata in G minor, HWV 393: I. Andante',
      parentMbid: 'hwv393',
      parentTitle: 'Trio Sonata in G minor, op. 2 no. 8, HWV 393',
    }),
  );
  assert.equal(level.mbid, 'self');
  assert.equal(level.needsReview, true);
});

test('a work with no parent is its own level', () => {
  const level = workLevelOf(node({ title: 'Symphony No. 5' }));
  assert.equal(level.mbid, 'self');
  assert.equal(level.reason, 'no-parent');
  assert.equal(level.needsReview, false);
});

test('a near-miss prefix does not count as naming the parent', () => {
  // Only an exact "<parent>:" prefix. Guessing at similar words here would
  // climb on a resemblance, which is how collections swallow pieces.
  const level = workLevelOf(
    node({
      title: 'Concerto for 2 Violins in A minor, RV 522: I. Allegro',
      parentMbid: 'other',
      parentTitle: 'Concerto for 2 Violins in A minor, RV 523',
    }),
  );
  assert.equal(level.mbid, 'self');
  assert.equal(level.needsReview, true);
});
