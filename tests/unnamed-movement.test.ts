import assert from 'node:assert/strict';
import test from 'node:test';
import { unnamedMovementNote, type Movement } from '../app/lib/prelude';

const movement = (name: string): Movement => ({
  n: 1,
  position: 1,
  roman: 'I',
  name,
  unnamed: true,
  missing: false,
  durationMs: null,
  duration: null,
  liked: false,
  trackId: null,
  uri: null,
});

test('an untitled movement marker only claims a Spotify title when one is shown', () => {
  assert.equal(unnamedMovementNote(movement('')), 'No MusicBrainz title');
  assert.equal(
    unnamedMovementNote(movement('Sonata No. 14 - I. Adagio sostenuto')),
    'No MusicBrainz title — showing the Spotify track title',
  );
});
