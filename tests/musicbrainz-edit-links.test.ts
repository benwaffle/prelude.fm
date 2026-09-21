import assert from 'node:assert/strict';
import test from 'node:test';
import { magicIsrcLink } from '../app/lib/musicbrainz-edit-links';
import type { IsrcGap } from '../app/lib/musicbrainz-edit-links';

function gap(partial: Partial<IsrcGap>): IsrcGap {
  return {
    spotifyTrackId: 't',
    trackTitle: 'A Track',
    albumId: 'a',
    albumTitle: 'An Album',
    isrc: 'GBAAA0000001',
    recordingMbid: 'rec',
    recordingTitle: 'A Recording',
    releaseMbid: 'rel',
    barcode: '123',
    medium: 1,
    position: 1,
    durationDeltaMs: 0,
    matchedBy: 'release_position',
    ...partial,
  };
}

test('every missing ISRC arrives in the link', () => {
  const link = new URL(
    magicIsrcLink('rel-1', [
      gap({ isrc: 'GBAAA0000001', medium: 1, position: 1 }),
      gap({ isrc: 'GBAAA0000002', medium: 1, position: 2 }),
    ]),
  );
  assert.equal(link.searchParams.get('musicbrainzid'), 'rel-1');
  assert.equal(link.searchParams.get('isrc1-1'), 'GBAAA0000001');
  assert.equal(link.searchParams.get('isrc1-2'), 'GBAAA0000002');
  assert.ok(link.searchParams.get('edit-note'));
});

test('an ISRC is addressed by its position on the release, not its place in the list', () => {
  // The bug this guards against put an ISRC on the first track of a release
  // because it happened to be first in our list, when the track it belongs to
  // is number three. That is an ISRC attached to the wrong recording — the
  // exact error these submissions exist to correct.
  const link = new URL(magicIsrcLink('rel-1', [gap({ isrc: 'GBAAA0000003', position: 3 })]));
  assert.equal(link.searchParams.get('isrc1-3'), 'GBAAA0000003');
  assert.equal(link.searchParams.get('isrc1-1'), null);
});

test('a second disc is addressed by its own medium', () => {
  const link = new URL(
    magicIsrcLink('rel-1', [gap({ isrc: 'GBAAA0000009', medium: 2, position: 4 })]),
  );
  assert.equal(link.searchParams.get('isrc2-4'), 'GBAAA0000009');
});
