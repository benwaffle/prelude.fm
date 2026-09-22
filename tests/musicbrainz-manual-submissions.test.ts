import assert from 'node:assert/strict';
import test from 'node:test';
import { barcodeSubmissionDraft } from '../app/lib/musicbrainz-manual-submissions';

test('a barcode draft keeps the exact value and both evidence routes', () => {
  assert.deepEqual(
    barcodeSubmissionDraft({
      releaseMbid: 'release-1',
      releaseTitle: 'A Release',
      albumId: 'spotify-1',
      barcode: '00028946813423',
      trackCount: 12,
      maxDurationDeltaMs: 2_100,
    }),
    {
      kind: 'barcode',
      targetMbid: 'release-1',
      subject: 'spotify-1',
      value: '00028946813423',
      evidence: {
        releaseTitle: 'A Release',
        spotifyAlbumId: 'spotify-1',
        spotifyUrl: 'https://open.spotify.com/album/spotify-1',
        musicbrainzUrl: 'https://musicbrainz.org/release/release-1',
        spotifyBarcode: '00028946813423',
        musicbrainzBarcodeBefore: null,
        verifiedTrackCount: 12,
        maxDurationDeltaMs: 2_100,
        durationToleranceMs: 5_000,
      },
    },
  );
});

test('a manual draft always has a non-null dedupe value', () => {
  const draft = barcodeSubmissionDraft({
    releaseMbid: 'release-1',
    releaseTitle: 'A Release',
    albumId: 'spotify-1',
    barcode: '123',
    trackCount: 1,
    maxDurationDeltaMs: 0,
  });
  assert.equal(typeof draft.value, 'string');
  assert.notEqual(draft.value, '');
});
