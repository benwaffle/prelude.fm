import assert from 'node:assert/strict';
import test from 'node:test';
import { editNoteFor } from '../app/lib/musicbrainz-isrc-submission';
import type { IsrcGap } from '../app/lib/musicbrainz-edit-links';

function gap(partial: Partial<IsrcGap> = {}): IsrcGap {
  return {
    spotifyTrackId: 't1',
    trackTitle: 'A Track',
    albumId: 'album1',
    albumTitle: 'An Album',
    isrc: 'GBAYE0601498',
    recordingMbid: 'rec1',
    recordingTitle: 'A Recording',
    releaseMbid: 'rel1',
    barcode: '028946813423',
    upc: '00028946813423',
    medium: 1,
    position: 1,
    durationDeltaMs: 0,
    matchedBy: 'release_position',
    ...partial,
  };
}

test('the note links the source an editor would check', () => {
  const note = editNoteFor([gap()]);
  assert.match(note, /https:\/\/open\.spotify\.com\/album\/album1/);
});

test('both barcodes appear, each labelled as whose it is', () => {
  // The same number written two ways — Spotify pads a UPC-12. Calling one of
  // them the other is the sort of small inaccuracy that costs a bot trust.
  const note = editNoteFor([gap()]);
  assert.match(note, /Spotify release with barcode 00028946813423/);
  assert.match(note, /this release: 028946813423/);
  assert.match(note, /without the leading zero/);
});

test('identical barcodes are not explained away as padding', () => {
  const note = editNoteFor([gap({ upc: '028946813423', barcode: '028946813423' })]);
  assert.match(note, /which is this release's barcode/);
  assert.doesNotMatch(note, /leading zero/);
});

test('the note bounds the whole batch by its worst duration difference', () => {
  // Quoting the closest match would flatter the batch; the worst is what an
  // editor is actually being asked to accept.
  const note = editNoteFor([
    gap({ durationDeltaMs: 0 }),
    gap({ durationDeltaMs: 2300 }),
    gap({ durationDeltaMs: 800 }),
  ]);
  assert.match(note, /within 2\.3s/);
  assert.match(note, /tolerance 3s/);
});

test('the note says how many and who sent them', () => {
  const note = editNoteFor([gap(), gap()]);
  assert.match(note, /^2 ISRC\(s\)/);
  assert.match(note, /prelude_fm_bot/);
  assert.match(note, /Replies to this note are read/);
});

test('the note does not restate which ISRC went where', () => {
  // The edit itself shows that; repeating it is noise in a review queue.
  const note = editNoteFor([gap({ isrc: 'GBAYE0601498' })]);
  assert.doesNotMatch(note, /GBAYE0601498/);
});

test('an empty batch has no note', () => {
  assert.equal(editNoteFor([]), '');
});

test('a sub-second difference is stated in milliseconds', () => {
  // "within 0.0s" reads like a rounding artefact and makes the number look
  // decorative rather than measured.
  assert.match(editNoteFor([gap({ durationDeltaMs: 1 })]), /within 1ms/);
  assert.match(editNoteFor([gap({ durationDeltaMs: 940 })]), /within 940ms/);
  assert.match(editNoteFor([gap({ durationDeltaMs: 2586 })]), /within 2\.6s/);
});
