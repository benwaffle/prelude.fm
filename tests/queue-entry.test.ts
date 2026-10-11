import assert from 'node:assert/strict';
import test from 'node:test';
import { queueEntryFor, type LibraryWork, type Movement } from '../app/lib/prelude';

const movement = (position: number, uri: string | null, missing = false): Movement => ({
  n: position,
  position,
  roman: '',
  name: `Movement ${position}`,
  unnamed: false,
  missing,
  durationMs: 1000,
  duration: '0:01',
  liked: false,
  trackId: uri,
  uri,
});

const work = (overrides: Partial<LibraryWork>): LibraryWork =>
  ({
    title: 'Piano Sonata no. 14',
    nickname: null,
    composer: 'Beethoven',
    composerFull: 'Ludwig van Beethoven',
    performer: 'Igor Levit',
    album: 'Beethoven: Complete Piano Sonatas',
    cover: null,
    movements: [
      movement(1, 'spotify:track:a'),
      movement(2, null, true),
      movement(3, 'spotify:track:c'),
    ],
    ...overrides,
  }) as LibraryWork;

test('a queued recording carries only the movements it can play, in order', () => {
  const entry = queueEntryFor(work({}));
  assert.deepEqual(entry.uris, ['spotify:track:a', 'spotify:track:c']);
  assert.equal(entry.title, 'Piano Sonata no. 14');
  assert.equal(entry.subtitle, 'Beethoven · Igor Levit');
});

test('an untitled work is queued under its album, not an invented title', () => {
  const entry = queueEntryFor(
    work({ title: null, performer: null, composer: null, composerFull: null }),
  );
  assert.equal(entry.title, 'Beethoven: Complete Piano Sonatas');
  assert.equal(entry.subtitle, null);
});
