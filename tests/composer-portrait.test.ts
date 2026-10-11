import assert from 'node:assert/strict';
import test from 'node:test';
import { spotifyArtistIdOf } from '../app/lib/musicbrainz-cache';
import { portraitOf } from '../app/lib/prelude';

const PROKOFIEV = '0e43fe9d-c472-4b62-be9e-55f971a023e1';

test('a composer takes the Spotify artist MusicBrainz links, and only that', () => {
  const link = (resource: string, ended = false) => ({
    type: 'free streaming',
    direction: 'forward' as const,
    ended,
    url: { resource },
  });
  const artist = (...relations: ReturnType<typeof link>[]) => ({
    id: PROKOFIEV,
    name: 'Сергей Сергеевич Прокофьев',
    relations,
  });

  assert.equal(
    spotifyArtistIdOf(
      artist(
        link('https://www.wikidata.org/wiki/Q49481'),
        link('https://open.spotify.com/artist/4kHtgiRnpmFIV5Tm4BIs8l'),
      ),
    ),
    '4kHtgiRnpmFIV5Tm4BIs8l',
  );
  assert.equal(
    spotifyArtistIdOf(artist(link('https://open.spotify.com/artist/4kHtgiRnpmFIV5Tm4BIs8l', true))),
    null,
  );
  assert.equal(
    spotifyArtistIdOf(artist(link('https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo'))),
    null,
  );
  assert.equal(spotifyArtistIdOf({ id: PROKOFIEV, name: 'Prokofiev' }), null);
});

test('a portrait is the smallest image that fills it, else the largest', () => {
  const images = [
    { url: 'large', width: 640 },
    { url: 'medium', width: 320 },
    { url: 'small', width: 160 },
  ];
  assert.equal(portraitOf(images), 'medium');
  assert.equal(
    portraitOf([
      { url: 'small', width: 160 },
      { url: 'tiny', width: 64 },
    ]),
    'small',
  );
  assert.equal(portraitOf([]), null);
  assert.equal(portraitOf(null), null);
});
