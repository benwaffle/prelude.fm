import assert from 'node:assert/strict';
import test from 'node:test';
import { programmeMovementName } from '../app/components/detail/programme-title';

const work = 'Concerto for Piano and Orchestra no. 2 in B-flat major, op. 83';

test('programme uses the work heading and numeral column without repeating either', () => {
  assert.equal(
    programmeMovementName(`${work}: I. Allegro non troppo`, work, 'I'),
    'Allegro non troppo',
  );
  assert.equal(
    programmeMovementName(`${work}: II. Allegro appassionato`, work, 'II'),
    'Allegro appassionato',
  );
});

test('programme leaves unrelated and missing MusicBrainz titles visible as given', () => {
  assert.equal(programmeMovementName('I. Allegro', work, 'II'), 'I. Allegro');
  assert.equal(
    programmeMovementName('Another concerto: I. Allegro', work, 'I'),
    'Another concerto: I. Allegro',
  );
  assert.equal(programmeMovementName('', work, 'I'), '');
  assert.equal(programmeMovementName(`${work}: I.`, work, 'I'), '');
  assert.equal(programmeMovementName('I. Allegro', null, 'I'), 'Allegro');
});
