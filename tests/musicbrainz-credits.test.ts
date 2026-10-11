import assert from 'node:assert/strict';
import test from 'node:test';
import {
  creditLine,
  hasPerformingCredits,
  performingCredits,
  type StoredCredit,
} from '../app/lib/musicbrainz-credits';

function credit(role: string, name: string, instrument = '', artistMbid = name): StoredCredit {
  return { artistMbid, name, role, instrument };
}

/** A real recording's credits, as cached from one release read. */
const vivaldi: StoredCredit[] = [
  credit('editor', 'Jean-Daniel Noir'),
  credit('engineer', 'Marie Delorme'),
  credit('instrument', 'Riccardo Minasi', 'violin'),
  credit('instrument', 'Dmitry Sinkovsky', 'violin'),
  credit('mix', 'Jean-Daniel Noir'),
  credit('performing orchestra', 'Il Pomo d’Oro'),
  credit('producer', 'Jean-Daniel Noir'),
  credit('sound', 'Jean-Daniel Noir'),
];

test('soloists keep their instruments and the orchestra is not one of them', () => {
  const credits = performingCredits(vivaldi);
  assert.deepEqual(credits.soloists, [
    { name: 'Riccardo Minasi', instrument: 'violin' },
    { name: 'Dmitry Sinkovsky', instrument: 'violin' },
  ]);
  assert.deepEqual(credits.ensembles, ['Il Pomo d’Oro']);
  assert.deepEqual(credits.conductors, []);
});

test('production roles are kept but stay out of the performing credits', () => {
  const credits = performingCredits(vivaldi);
  const roles = credits.production.map((entry) => entry.role).sort();
  assert.deepEqual(roles, ['editor', 'engineer', 'mix', 'producer', 'sound']);
});

test('an unfamiliar role is production, not a performer', () => {
  // The cache really does hold `balance`, `creative direction` and
  // `instrument technician`. A denylist would promote the next new one into
  // the credit line.
  const credits = performingCredits([
    credit('instrument technician', 'A Piano Tuner'),
    credit('balance', 'A Balance Engineer'),
    credit('creative direction', 'A Designer'),
  ]);
  assert.deepEqual(credits.soloists, []);
  assert.equal(credits.production.length, 3);
});

test('one artist holding two roles is named once', () => {
  const credits = performingCredits([
    credit('instrument', 'Daniel Barenboim', 'piano', 'mbid-1'),
    credit('conductor', 'Daniel Barenboim', '', 'mbid-1'),
  ]);
  assert.equal(credits.soloists.length, 1);
  assert.equal(credits.conductors.length, 1);
  assert.deepEqual(creditLine(credits), {
    performer: 'Daniel Barenboim',
    ensemble: null,
  });
});

test('a concerto reads as soloist and orchestra', () => {
  assert.deepEqual(creditLine(performingCredits(vivaldi)), {
    performer: 'Riccardo Minasi',
    ensemble: 'Il Pomo d’Oro',
  });
});

test('a symphony with no soloist reads as conductor and orchestra', () => {
  const credits = performingCredits([
    credit('conductor', 'Carlos Kleiber'),
    credit('performing orchestra', 'Wiener Philharmoniker'),
  ]);
  assert.deepEqual(creditLine(credits), {
    performer: 'Carlos Kleiber',
    ensemble: 'Wiener Philharmoniker',
  });
});

test('a solo recital fills one slot and leaves the other empty', () => {
  const credits = performingCredits([credit('instrument', 'Vladimir Horowitz', 'piano')]);
  assert.deepEqual(creditLine(credits), { performer: 'Vladimir Horowitz', ensemble: null });
});

test('a recording MusicBrainz credits to nobody says so rather than guessing', () => {
  // The point of replacing the frequency count: where there is nothing to
  // say, say nothing.
  const credits = performingCredits([credit('producer', 'Someone')]);
  assert.deepEqual(creditLine(credits), { performer: null, ensemble: null });
});

test('a choir is an ensemble, not a soloist', () => {
  // MusicBrainz credits a choir as a vocal, because a choir sings. Reading
  // that literally puts sixty voices in the soloist slot and pushes the
  // actual singer out of the credit line.
  const credits = performingCredits([
    credit('vocal', 'Monteverdi Choir', 'choir vocals'),
    credit('vocal', 'Robin Blaze', 'alto vocals'),
    credit('conductor', 'John Eliot Gardiner'),
  ]);
  assert.deepEqual(credits.ensembles, ['Monteverdi Choir']);
  assert.deepEqual(credits.soloists, [{ name: 'Robin Blaze', instrument: 'alto vocals' }]);
  assert.deepEqual(creditLine(credits), {
    performer: 'Robin Blaze',
    ensemble: 'Monteverdi Choir',
  });
});

test('a chorus is read the same way as a choir', () => {
  const credits = performingCredits([credit('vocal', 'Wiener Singverein', 'chorus vocals')]);
  assert.deepEqual(credits.ensembles, ['Wiener Singverein']);
});

test('a solo singer is still a soloist', () => {
  const credits = performingCredits([credit('vocal', 'Lucia Valentini Terrani', 'alto vocals')]);
  assert.deepEqual(credits.soloists, [
    { name: 'Lucia Valentini Terrani', instrument: 'alto vocals' },
  ]);
});

test('a recording with only production credits has nothing to say about performers', () => {
  // The reader uses this to keep the name it already had rather than
  // replacing a real credit with a blank.
  assert.equal(hasPerformingCredits(performingCredits([credit('producer', 'Someone')])), false);
  assert.equal(
    hasPerformingCredits(performingCredits([credit('instrument', 'Someone', 'piano')])),
    true,
  );
});
