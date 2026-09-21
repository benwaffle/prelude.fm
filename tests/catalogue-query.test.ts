import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCatalogueQuery } from '../app/lib/catalogue-query';

test('a sigil and a number is a catalogue reference', () => {
  assert.deepEqual(parseCatalogueQuery('BWV 1067'), {
    kind: 'reference',
    system: 'bwv',
    number: '1067',
  });
  assert.deepEqual(parseCatalogueQuery('K. 551'), {
    kind: 'reference',
    system: 'k',
    number: '551',
  });
  assert.deepEqual(parseCatalogueQuery('L 413'), {
    kind: 'reference',
    system: 'l',
    number: '413',
  });
});

test('a reference is read the same however it is punctuated or cased', () => {
  const canonical = { kind: 'reference', system: 'bwv', number: '1067' };
  assert.deepEqual(parseCatalogueQuery('bwv1067'), canonical);
  assert.deepEqual(parseCatalogueQuery('BWV. 1067'), canonical);
  assert.deepEqual(parseCatalogueQuery('  bwv  1067  '), canonical);
});

test('a structured number keeps its structure', () => {
  assert.deepEqual(parseCatalogueQuery('Hob. I:82'), {
    kind: 'reference',
    system: 'hob',
    number: 'i:82',
  });
  assert.deepEqual(parseCatalogueQuery('BWV 1006a'), {
    kind: 'reference',
    system: 'bwv',
    number: '1006a',
  });
});

test('a bare number can match any catalogue', () => {
  // Someone who remembers 1067 but not that it is a BWV number.
  assert.deepEqual(parseCatalogueQuery('1067'), { kind: 'number', number: '1067' });
});

test('a word followed by a number is a title, not a reference', () => {
  // "Sonata 3" is someone typing a title. Reading it as catalogue system
  // "sonata" would find nothing and hide the works that do match.
  assert.deepEqual(parseCatalogueQuery('Sonata 3'), { kind: 'text', text: 'sonata 3' });
});

test('a name or title is text', () => {
  assert.deepEqual(parseCatalogueQuery('Moonlight'), { kind: 'text', text: 'moonlight' });
  assert.deepEqual(parseCatalogueQuery('Bach'), { kind: 'text', text: 'bach' });
});

test('an empty query is empty text rather than a match on everything', () => {
  assert.deepEqual(parseCatalogueQuery('   '), { kind: 'text', text: '' });
});
