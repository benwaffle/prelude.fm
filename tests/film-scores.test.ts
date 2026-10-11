import assert from 'node:assert/strict';
import test from 'node:test';
import { filmScoreReason, isSoundtrackAlbum, type FilmScoreWork } from '../app/lib/film-scores';

const ZIMMER = 'e6de1f3b-6484-491c-88dd-6d619f142abc';
const ZIMMER_SPOTIFY = '0YC192cP3KPCRWx8zr8MfZ';
const CHOPIN = '09ff1fe8-d61c-4b98-bb82-18487c74d7b7';
const GLASS = '5ae54dee-4dba-49c0-802a-a3b3b3adfe9b';

function tree(...works: FilmScoreWork[]) {
  return new Map(works.map((work) => [work.mbid, work]));
}

const concertAlbum = { spotifyAlbumId: 'album-concert', title: 'Glass: Piano Works' };
const soundtrack = {
  spotifyAlbumId: 'album-ost',
  title: 'The Pianist (Original Motion Picture Soundtrack)',
};

test('a work by a film composer is a film score, wherever it is issued', () => {
  const reason = filmScoreReason(
    { workMbids: ['cue'], spotifyArtistIds: [], album: concertAlbum },
    tree(
      { mbid: 'cue', type: null, parentMbid: 'score', composerMbid: null },
      { mbid: 'score', type: 'Suite', parentMbid: null, composerMbid: ZIMMER },
    ),
    new Set(),
  );
  assert.match(reason ?? '', /MusicBrainz credits Hans Zimmer/);
});

test('Spotify crediting a film composer catches a cue MusicBrainz has not linked', () => {
  const reason = filmScoreReason(
    { workMbids: [], spotifyArtistIds: ['someone', ZIMMER_SPOTIFY], album: null },
    tree(),
    new Set(),
  );
  assert.match(reason ?? '', /Spotify credits Hans Zimmer/);
});

test('a soundtrack album excludes what MusicBrainz does not call classical', () => {
  const reason = filmScoreReason(
    { workMbids: [], spotifyArtistIds: [], album: soundtrack },
    tree(),
    new Set(),
  );
  assert.match(reason ?? '', /on the soundtrack album "The Pianist/);
});

test('a classical work on a soundtrack album stays', () => {
  const reason = filmScoreReason(
    { workMbids: ['nocturne'], spotifyArtistIds: [], album: soundtrack },
    tree({ mbid: 'nocturne', type: null, parentMbid: null, composerMbid: CHOPIN }),
    new Set(['nocturne']),
  );
  assert.equal(reason, null);
});

test('a concert work by a composer who also scores films stays', () => {
  const reason = filmScoreReason(
    { workMbids: ['etude'], spotifyArtistIds: [], album: concertAlbum },
    tree({ mbid: 'etude', type: null, parentMbid: null, composerMbid: GLASS }),
    new Set(),
  );
  assert.equal(reason, null);
});

test('soundtrack albums are recognised by title or by the list', () => {
  assert.ok(
    isSoundtrackAlbum({
      spotifyAlbumId: 'x',
      title: 'Succession: Season 2 (Music from the HBO Series)',
    }),
  );
  assert.ok(
    isSoundtrackAlbum({ spotifyAlbumId: 'x', title: 'The Leftovers (Music from the HBO® Series)' }),
  );
  assert.ok(
    isSoundtrackAlbum({ spotifyAlbumId: '2Jqqt4hlvKdQpPWjpLg33L', title: 'The Lone Ranger' }),
  );
  assert.ok(!isSoundtrackAlbum({ spotifyAlbumId: 'x', title: 'Vivaldi: The Four Seasons' }));
  assert.ok(!isSoundtrackAlbum({ spotifyAlbumId: 'x', title: '50 Best Film' }));
});
