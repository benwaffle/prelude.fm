import assert from 'node:assert/strict';
import test from 'node:test';
import { classicalComposerReason } from '../app/lib/classical-composers';
import { FILM_COMPOSERS } from '../app/lib/film-scores';

test('a track crediting a listed composer is classical, film composers are not listed', () => {
  assert.match(classicalComposerReason(['nobody', '7A3EfKcEMZeHldRMXJmB45']) ?? '', /Aalampour/);
  assert.equal(classicalComposerReason(['nobody']), null);
  for (const composer of FILM_COMPOSERS) {
    if (composer.spotifyId) assert.equal(classicalComposerReason([composer.spotifyId]), null);
  }
});
