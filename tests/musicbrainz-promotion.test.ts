import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decidePromotion,
  formFromWorkType,
  textuallyEqual,
  yearsEqual,
} from '../app/lib/musicbrainz-promotion';

test('fills a field we have never filled', () => {
  assert.equal(decidePromotion(null, 'Sonata'), 'fill');
  assert.equal(decidePromotion(undefined, 'Sonata'), 'fill');
});

test('treats a blank value as a gap, not as a claim', () => {
  // A movement row carrying "" or "   " has no content; refusing to fill it
  // would strand the gap forever behind a value that says nothing.
  assert.equal(decidePromotion('', 'Allegro'), 'fill');
  assert.equal(decidePromotion('   ', 'Allegro'), 'fill');
});

test('never overwrites a value we already hold', () => {
  assert.equal(decidePromotion('chorale prelude', 'prelude', textuallyEqual), 'conflict');
});

test('counts a match as agreement rather than a write', () => {
  assert.equal(decidePromotion('sonata', 'sonata', textuallyEqual), 'agree');
});

test('ignores case, accents and punctuation when comparing text', () => {
  assert.equal(decidePromotion('Introit et Kyrie', 'Introït et Kyrie', textuallyEqual), 'agree');
  assert.equal(decidePromotion('IV. Bourree I/II', 'IV. Bourrée I/II', textuallyEqual), 'agree');
  assert.equal(decidePromotion('Song-cycle', 'song cycle', textuallyEqual), 'agree');
});

test('compares years exactly', () => {
  assert.equal(decidePromotion('1845', '1845', yearsEqual), 'agree');
  assert.equal(decidePromotion('1845', '1846', yearsEqual), 'conflict');
  assert.equal(decidePromotion(null, '1845', yearsEqual), 'fill');
});

test('lower-cases MusicBrainz work types to match the form column', () => {
  assert.equal(formFromWorkType('Sonata'), 'sonata');
  assert.equal(formFromWorkType('Symphonic poem'), 'symphonic poem');
  assert.equal(formFromWorkType('Étude'), 'étude');
});

test('a differing year is a conflict even when one side has extra whitespace', () => {
  assert.equal(decidePromotion('1685', ' 1685 ', yearsEqual), 'agree');
});
