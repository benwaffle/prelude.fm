import assert from 'node:assert/strict';
import test from 'node:test';
import { listedComposerOf } from '../app/lib/classical-composers';
import { FILM_COMPOSERS } from '../app/lib/film-scores';

test('a track crediting a listed composer is classical, film composers are not listed', () => {
  assert.match(listedComposerOf(['nobody', '7A3EfKcEMZeHldRMXJmB45']) ?? '', /Aalampour/);
  assert.equal(listedComposerOf(['nobody']), null);
  for (const composer of FILM_COMPOSERS) {
    if (composer.spotifyId) assert.equal(listedComposerOf([composer.spotifyId]), null);
  }
});
