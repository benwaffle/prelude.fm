import assert from 'node:assert/strict';
import test from 'node:test';
import type { AlbumTrack } from '../app/lib/musicbrainz-library';
import { musicBrainzLibraryView } from '../app/lib/musicbrainz-library-view';

function albumTrack(id: string, trackNumber: number, listedComposer: string | null): AlbumTrack {
  return {
    listedComposer,
    gaps: [{ code: 'release-missing', entity: 'album', entityId: 'album-1', detail: null }],
    occurrence: {
      spotifyTrackId: id,
      providerTitle: `Track ${trackNumber}`,
      spotifyAlbumId: 'album-1',
      providerAlbumTitle: 'Winter Solace',
      imageUrl: null,
      discNumber: 1,
      trackNumber,
      durationMs: 60_000,
      popularity: null,
      popularityState: 'unranked',
      held: true,
      albumAnchoredTrackCount: 0,
      releaseMbid: null,
      releaseTitle: null,
      releaseDate: null,
      releaseTrackTitle: null,
      gaps: [],
    },
  };
}

const view = (albumTracks: AlbumTrack[]) =>
  musicBrainzLibraryView(
    { requestedTrackIds: [], recordings: [], albumTracks, unresolvedTracks: [], accounting: [] },
    new Set(['t2']),
  );

test('tracks with no work share one card per Spotify album, in album order, marked unmatched', () => {
  const [card, ...rest] = view([
    albumTrack('t2', 2, 'Joshua Kyan Aalampour'),
    albumTrack('t1', 1, 'Joshua Kyan Aalampour'),
  ]).works;
  assert.equal(rest.length, 0);
  assert.equal(card.title, 'Winter Solace');
  assert.equal(card.unmatched, true);
  assert.equal(card.composerFull, 'Joshua Kyan Aalampour');
  assert.deepEqual(
    card.movements.map((movement) => [movement.trackId, movement.roman, movement.liked]),
    [
      ['t1', '', false],
      ['t2', '', true],
    ],
  );
  assert.deepEqual(card.gaps, ['release-missing']);
});

test('an album card names no composer when its tracks credit different ones', () => {
  const [card] = view([albumTrack('t1', 1, 'Bach'), albumTrack('t2', 2, 'Handel')]).works;
  assert.equal(card.composerFull, null);
});
