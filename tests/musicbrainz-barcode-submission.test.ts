import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBarcodeSubmission,
  editCount,
  editNoteFor,
} from '../app/lib/musicbrainz-barcode-submission';

const RELEASE = '047ea202-b98d-46ae-97f7-0180a20ee5cf';

test('buildBarcodeSubmission nests barcodes under releases', () => {
  const xml = buildBarcodeSubmission([
    { releaseMbid: RELEASE, barcode: '4050538793819' },
    { releaseMbid: '11111111-1111-1111-1111-111111111111', barcode: '00028946813423' },
  ]);
  assert.match(xml, /<release-list>/);
  assert.match(xml, new RegExp(`<release id="${RELEASE}">`));
  assert.match(xml, /<barcode>4050538793819<\/barcode>/);
  assert.match(xml, /<barcode>00028946813423<\/barcode>/);
});

test('buildBarcodeSubmission carries the edit note inside the document', () => {
  const xml = buildBarcodeSubmission(
    [{ releaseMbid: RELEASE, barcode: '4050538793819' }],
    'barcode from Spotify',
  );
  assert.match(xml, /<edit-note>barcode from Spotify<\/edit-note>/);
});

test('editCount counts one edit per release barcode', () => {
  assert.equal(
    editCount([
      { releaseMbid: RELEASE, barcode: '4050538793819' },
      { releaseMbid: '11111111-1111-1111-1111-111111111111', barcode: '00028946813423' },
    ]),
    2,
  );
});

test('editNoteFor names the Spotify source and duration evidence', () => {
  const note = editNoteFor([
    {
      releaseMbid: RELEASE,
      releaseTitle: 'A Release',
      albumId: 'spotify-1',
      barcode: '00028946813423',
      trackCount: 12,
      maxDurationDeltaMs: 2_100,
    },
  ]);
  assert.match(note, /00028946813423/);
  assert.match(note, /open\.spotify\.com\/album\/spotify-1/);
  assert.match(note, /musicbrainz\.org\/release\//);
  assert.match(note, /2\.1s/);
  assert.match(note, /prelude_fm_bot/);
});
