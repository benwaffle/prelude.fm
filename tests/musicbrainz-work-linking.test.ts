import assert from 'node:assert/strict';
import test from 'node:test';
import { decideWorkLinks } from '../app/lib/musicbrainz-work-linking';

test('a work whose tracks all reach one MusicBrainz work is linked', () => {
  const decisions = decideWorkLinks([
    { workId: 1, mbid: 'mb-a', tracks: 3 },
    { workId: 1, mbid: 'mb-a', tracks: 1 },
  ]);
  assert.deepEqual(decisions, [{ workId: 1, mbid: 'mb-a', reason: 'unanimous' }]);
});

test('a work whose tracks disagree is left unlinked', () => {
  // Tracks of one work pointing at two MusicBrainz works means something
  // upstream is wrong. Voting would bury that.
  const decisions = decideWorkLinks([
    { workId: 1, mbid: 'mb-a', tracks: 9 },
    { workId: 1, mbid: 'mb-b', tracks: 1 },
  ]);
  assert.deepEqual(decisions, [{ workId: 1, mbid: null, reason: 'divided' }]);
});

test('two of our works cannot both claim one MusicBrainz work', () => {
  // That would assert they are the same piece, which is a merge, and a merge
  // is not something to infer from a rollup.
  const decisions = decideWorkLinks([
    { workId: 1, mbid: 'mb-a', tracks: 2 },
    { workId: 2, mbid: 'mb-a', tracks: 2 },
  ]);
  assert.equal(decisions.filter((d) => d.mbid === 'mb-a').length, 1);
  assert.equal(decisions.find((d) => d.workId === 2)?.reason, 'contested');
});

test('a MusicBrainz work already linked to another work is not stolen', () => {
  const decisions = decideWorkLinks(
    [{ workId: 7, mbid: 'mb-a', tracks: 4 }],
    new Map([['mb-a', 3]]),
  );
  assert.deepEqual(decisions, [{ workId: 7, mbid: null, reason: 'contested' }]);
});

test('a work relinking to the MusicBrainz work it already has is fine', () => {
  const decisions = decideWorkLinks(
    [{ workId: 3, mbid: 'mb-a', tracks: 4 }],
    new Map([['mb-a', 3]]),
  );
  assert.deepEqual(decisions, [{ workId: 3, mbid: 'mb-a', reason: 'unanimous' }]);
});
