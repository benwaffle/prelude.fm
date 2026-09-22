import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classicalEvidenceFor,
  type ClassicalEvidenceWork,
} from '../app/lib/musicbrainz-classical-evidence';

function tree(...works: ClassicalEvidenceWork[]) {
  return new Map(works.map((work) => [work.mbid, work]));
}

test('a work relation on its own says nothing', () => {
  // MusicBrainz files works for popular songs too. This is the rule the
  // reader must not have: it would put a chart single under a composer.
  const evidence = classicalEvidenceFor(
    ['work-song'],
    tree({ mbid: 'work-song', type: null, parentMbid: null }),
    new Set(),
  );
  assert.equal(evidence.state, 'inconclusive');
});

test('a work MusicBrainz types as Song is still not evidence', () => {
  const evidence = classicalEvidenceFor(
    ['work-song'],
    tree({ mbid: 'work-song', type: 'Song', parentMbid: null }),
    new Set(),
  );
  assert.equal(evidence.state, 'inconclusive');
  assert.match(evidence.reason, /Song does not distinguish art music/);
});

test('a catalogue-series reference is evidence', () => {
  const evidence = classicalEvidenceFor(
    ['work-bwv-988'],
    tree({ mbid: 'work-bwv-988', type: null, parentMbid: null }),
    new Set(['work-bwv-988']),
  );
  assert.equal(evidence.state, 'classical');
  assert.match(evidence.reason, /catalogue-series reference/);
});

test('an art-music work type is evidence', () => {
  const evidence = classicalEvidenceFor(
    ['work-symphony'],
    tree({ mbid: 'work-symphony', type: 'Symphony', parentMbid: null }),
    new Set(),
  );
  assert.equal(evidence.state, 'classical');
  assert.match(evidence.reason, /types work-symphony as Symphony/);
});

test('the evidence may sit on an ancestor, where MusicBrainz files it', () => {
  // BWV 988 is filed against the Goldberg Variations, not against its Aria.
  const evidence = classicalEvidenceFor(
    ['work-aria'],
    tree(
      { mbid: 'work-aria', type: null, parentMbid: 'work-goldberg' },
      { mbid: 'work-goldberg', type: null, parentMbid: null },
    ),
    new Set(['work-goldberg']),
  );
  assert.equal(evidence.state, 'classical');
  assert.match(evidence.reason, /work-goldberg/);
});

test('a cycle in the cached hierarchy does not hang the walk', () => {
  const evidence = classicalEvidenceFor(
    ['work-a'],
    tree(
      { mbid: 'work-a', type: null, parentMbid: 'work-b' },
      { mbid: 'work-b', type: null, parentMbid: 'work-a' },
    ),
    new Set(),
  );
  assert.equal(evidence.state, 'inconclusive');
});

test('a recording of no work is inconclusive, not negative', () => {
  const evidence = classicalEvidenceFor([], tree(), new Set());
  assert.equal(evidence.state, 'inconclusive');
  assert.match(evidence.reason, /relates this recording to no work/);
});

test('one work carrying evidence is enough for a medley', () => {
  const evidence = classicalEvidenceFor(
    ['work-song', 'work-sonata'],
    tree(
      { mbid: 'work-song', type: 'Song', parentMbid: null },
      { mbid: 'work-sonata', type: 'Sonata', parentMbid: null },
    ),
    new Set(),
  );
  assert.equal(evidence.state, 'classical');
});
