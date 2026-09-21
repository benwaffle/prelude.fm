import assert from 'node:assert/strict';
import test from 'node:test';
import { splitCatalogueReference } from '../app/lib/musicbrainz-catalogue';

test('a sigil and a number are separated the way a reader writes them', () => {
  const bwv = splitCatalogueReference('Bach-Werke-Verzeichnis', 'BWV 912');
  assert.deepEqual(bwv, {
    system: 'BWV',
    number: '912',
    normalizedSystem: 'bwv',
    normalizedNumber: '912',
  });
});

test('the split matches what the parser stores, so the two can be looked up together', () => {
  // The parser records system 'BWV', number '912'; the point of splitting is
  // that both land on the same normalized pair.
  const imported = splitCatalogueReference('Bach-Werke-Verzeichnis', 'BWV 912');
  assert.equal(imported?.normalizedSystem, 'bwv');
  assert.equal(imported?.normalizedNumber, '912');
});

/** The pair a reader would write, ignoring the normalized forms. */
function printed(series: string, reference: string) {
  const split = splitCatalogueReference(series, reference);
  return split && { system: split.system, number: split.number };
}

test('a sigil with a full stop keeps it, and the number keeps its structure', () => {
  assert.deepEqual(printed('Hoboken-Verzeichnis', 'Hob. I:82'), {
    system: 'Hob.',
    number: 'I:82',
  });
  assert.deepEqual(printed('The Music of Liszt', 'S. 516a'), {
    system: 'S.',
    number: '516a',
  });
  assert.deepEqual(printed('Works of Pyotr Ilyich Tchaikovsky by opus number', 'op. 19'), {
    system: 'op.',
    number: '19',
  });
});

test('an appendix number stays with the number, not the sigil', () => {
  assert.deepEqual(printed('Bach-Werke-Verzeichnis', 'BWV Anh. 113'), {
    system: 'BWV',
    number: 'Anh. 113',
  });
});

test('a sigil written without a space is still a sigil', () => {
  assert.deepEqual(printed('Ryom-Verzeichnis', 'RV632'), {
    system: 'RV',
    number: '632',
  });
});

test('a bare number keeps the series name, rather than inventing a sigil', () => {
  assert.deepEqual(printed('Some Catalogue', '12'), {
    system: 'Some Catalogue',
    number: '12',
  });
});

test('an empty reference is not a catalogue reference', () => {
  assert.equal(splitCatalogueReference('Bach-Werke-Verzeichnis', '   '), null);
});

test('a bare-numbered series takes the sigil it is written with', () => {
  // MusicBrainz's Köchel series calls Mozart's 41st symphony "551" and
  // nothing else. Filed under the series name it cannot be found by the K
  // number every listener knows.
  assert.deepEqual(printed('Köchelverzeichnis', '551'), { system: 'KV', number: '551' });
  assert.deepEqual(
    printed("Alessandro Longo's catalog of Domenico Scarlatti's keyboard works", '375'),
    { system: 'L', number: '375' },
  );
});

test('a series whose sigil we do not know keeps its name rather than inventing one', () => {
  assert.deepEqual(printed('Some Unknown Catalogue', '12'), {
    system: 'Some Unknown Catalogue',
    number: '12',
  });
});

test('a sigil in the reference still wins over the series lookup', () => {
  assert.deepEqual(printed('Köchelverzeichnis', 'KV 551'), { system: 'KV', number: '551' });
});
