import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composerMatchIsCredible,
  decidePromotion,
  formFromWorkType,
  movementTitleFromMusicBrainz,
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

test('accepts a composer whose name matches', () => {
  assert.equal(composerMatchIsCredible('Gabriel Fauré', 1845, 'Gabriel Faure', 1845), true);
});

test('accepts MusicBrainz spelling a composer in their own script', () => {
  // Demanding matching names would discard most of the composers worth having.
  assert.equal(
    composerMatchIsCredible('Dmitri Shostakovich', 1906, 'Дмитрий Дмитриевич Шостакович', 1906),
    true,
  );
  assert.equal(composerMatchIsCredible('Frédéric Chopin', 1810, 'Fryderyk Chopin', 1810), true);
  assert.equal(composerMatchIsCredible('Béla Bartók', 1881, 'Bartók Béla', 1881), true);
});

test('tolerates small scholarly disagreement about a birth year', () => {
  assert.equal(
    composerMatchIsCredible(
      'Friedrich Kalkbrenner',
      1785,
      'Friedrich Wilhelm Michael Kalkbrenner',
      1784,
    ),
    true,
  );
});

test('rejects a composer confused with their own brother', () => {
  // Giovanni Battista and Giuseppe Baldassare Sammartini: five years and one
  // forename apart, and the reason this guard exists.
  assert.equal(
    composerMatchIsCredible(
      'Giovanni Battista Sammartini',
      1700,
      'Giuseppe Baldassare Sammartini',
      1695,
    ),
    false,
  );
});

test('rejects an arranger collapsed into the composer they arranged', () => {
  assert.equal(
    composerMatchIsCredible('Ottorino Respighi', 1879, 'Johann Sebastian Bach', 1685),
    false,
  );
  assert.equal(
    composerMatchIsCredible('Johann Christian Bach', 1735, 'Henri Gustave Casadesus', 1879),
    false,
  );
});

test('rejects a differing name when we have no date to corroborate it', () => {
  // "Anonymous" and a performing duo both reach an artist this way.
  assert.equal(composerMatchIsCredible('Anonymous', null, '[traditional]', null), false);
  assert.equal(
    composerMatchIsCredible('Rodrigo y Gabriela', null, 'Gabriela Quintero', 1973),
    false,
  );
});

test('removes numbering we already hold in the label', () => {
  // Stored verbatim beside label "II", this renders "II. II. Larghetto".
  assert.equal(movementTitleFromMusicBrainz('II. Larghetto', 'II'), 'Larghetto');
  assert.equal(movementTitleFromMusicBrainz('III. Rondo. Allegro', 'III'), 'Rondo. Allegro');
  assert.equal(movementTitleFromMusicBrainz('4. Largo e spiccato', '4'), 'Largo e spiccato');
});

test('removes the work title MusicBrainz prefixes onto a movement', () => {
  assert.equal(
    movementTitleFromMusicBrainz(
      'Concerto in A minor for Two Violins, op. 3 no. 8, RV 522: III. Allegro',
      'III',
    ),
    'Allegro',
  );
});

test('refuses a work title offered as a movement title', () => {
  // A part labelled "Prelude No. 9" is not called "Prelude and Fugue no. 9 in
  // E major, BWV 854". An honest blank beats a plausible wrong value.
  assert.equal(
    movementTitleFromMusicBrainz(
      'Prelude and Fugue no. 9 in E major, BWV 854.2/854',
      'Prelude No. 9',
    ),
    null,
  );
  assert.equal(movementTitleFromMusicBrainz('Concerto in F major, op. 1 no. 1', 'I'), null);
});

test('strips generic numbering even when it disagrees with our label', () => {
  // Our numbering stays ours; only the descriptive text is taken.
  assert.equal(
    movementTitleFromMusicBrainz('II. Sehr innig und nicht zu rasch', 'Intermezzo I'),
    'Sehr innig und nicht zu rasch',
  );
});

test('leaves an unnumbered movement title alone', () => {
  assert.equal(movementTitleFromMusicBrainz('Tuba mirum', null), 'Tuba mirum');
  assert.equal(movementTitleFromMusicBrainz('Kyrie eleison', 'I'), 'Kyrie eleison');
});

test('returns null when nothing survives', () => {
  assert.equal(movementTitleFromMusicBrainz('III.', 'III'), null);
  assert.equal(movementTitleFromMusicBrainz('   ', null), null);
});
