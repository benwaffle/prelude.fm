import assert from 'node:assert/strict';
import test from 'node:test';
import {
  releaseMediumKey,
  verifyBarcodeRelease,
  verifiedIsrcReleaseMedia,
  type MusicBrainzReleaseEvidence,
  type SpotifyReleaseEvidence,
} from '../app/lib/musicbrainz-contribution-safety';

test('barcode evidence requires title, count, and every duration within five seconds', () => {
  const spotifyRows = [
    { albumTitle: 'A Release', discNumber: 1, trackNumber: 1, durationMs: 100_000 },
    { albumTitle: 'A Release', discNumber: 1, trackNumber: 2, durationMs: 200_000 },
  ];
  const musicbrainzRows = [
    { releaseTitle: 'A Release', medium: 1, position: 1, durationMs: 104_999 },
    { releaseTitle: 'A Release', medium: 1, position: 2, durationMs: 198_000 },
  ];
  assert.deepEqual(verifyBarcodeRelease(spotifyRows, musicbrainzRows), {
    trackCount: 2,
    maxDurationDeltaMs: 4_999,
  });
  assert.equal(verifyBarcodeRelease(spotifyRows, musicbrainzRows.slice(0, 1)), null);
  assert.equal(
    verifyBarcodeRelease(spotifyRows, [
      musicbrainzRows[0],
      { ...musicbrainzRows[1], durationMs: 205_001 },
    ]),
    null,
  );
  assert.equal(
    verifyBarcodeRelease(spotifyRows, [
      musicbrainzRows[0],
      { ...musicbrainzRows[1], durationMs: null },
    ]),
    null,
  );
  assert.equal(
    verifyBarcodeRelease(
      spotifyRows,
      musicbrainzRows.map((row) => ({ ...row, releaseTitle: 'Other' })),
    ),
    null,
  );
});

function spotify(
  partial: Partial<SpotifyReleaseEvidence> & Pick<SpotifyReleaseEvidence, 'spotifyTrackId'>,
): SpotifyReleaseEvidence {
  return {
    albumId: 'album',
    releaseMbid: 'release',
    upc: '00123',
    recordingMbid: `recording-${partial.spotifyTrackId}`,
    durationMs: 100_000,
    ...partial,
  };
}

function musicbrainz(
  partial: Partial<MusicBrainzReleaseEvidence> & Pick<MusicBrainzReleaseEvidence, 'position'>,
): MusicBrainzReleaseEvidence {
  return {
    releaseMbid: 'release',
    barcode: '123',
    medium: 1,
    recordingMbid: `recording-t${partial.position}`,
    durationMs: 100_000,
    ...partial,
  };
}

function verified(
  spotifyRows: SpotifyReleaseEvidence[],
  musicbrainzRows: MusicBrainzReleaseEvidence[],
): boolean {
  return verifiedIsrcReleaseMedia(spotifyRows, musicbrainzRows).has(
    releaseMediumKey('album', 'release', 1),
  );
}

test('a complete release with the same padded barcode and close durations is verified', () => {
  assert.equal(
    verified(
      [spotify({ spotifyTrackId: 't1' }), spotify({ spotifyTrackId: 't2' })],
      [musicbrainz({ position: 1 }), musicbrainz({ position: 2 })],
    ),
    true,
  );
});

test('an identical track count is required', () => {
  assert.equal(
    verified(
      [spotify({ spotifyTrackId: 't1' })],
      [musicbrainz({ position: 1 }), musicbrainz({ position: 2 })],
    ),
    false,
  );
});

test('a multi-disc release is verified as one complete tracklist', () => {
  assert.equal(
    verified(
      [spotify({ spotifyTrackId: 't1' }), spotify({ spotifyTrackId: 't2' })],
      [
        musicbrainz({ position: 1 }),
        musicbrainz({ position: 1, medium: 2, recordingMbid: 'recording-t2' }),
      ],
    ),
    true,
  );
});

test('matching only one disc of a multi-disc release is not whole-release evidence', () => {
  assert.equal(
    verified(
      [spotify({ spotifyTrackId: 't1' })],
      [
        musicbrainz({ position: 1 }),
        musicbrainz({ position: 1, medium: 2, recordingMbid: 'recording-t2' }),
      ],
    ),
    false,
  );
});

test('repeated hybrid layers are accepted only when every layer is complete', () => {
  const spotifyRows = [spotify({ spotifyTrackId: 't1' }), spotify({ spotifyTrackId: 't2' })];
  const completeLayers = [1, 2].flatMap((medium) => [
    musicbrainz({ position: 1, medium }),
    musicbrainz({ position: 2, medium }),
  ]);
  assert.equal(verified(spotifyRows, completeLayers), true);
  assert.equal(
    verified(spotifyRows, [...completeLayers.slice(0, 2), musicbrainz({ position: 1, medium: 2 })]),
    false,
  );
});

test('every duration must exist and agree within three seconds', () => {
  const tracks = [spotify({ spotifyTrackId: 't1' }), spotify({ spotifyTrackId: 't2' })];
  assert.equal(
    verified(tracks, [
      musicbrainz({ position: 1 }),
      musicbrainz({ position: 2, durationMs: null }),
    ]),
    false,
  );
  assert.equal(
    verified(tracks, [
      musicbrainz({ position: 1 }),
      musicbrainz({ position: 2, durationMs: 103_001 }),
    ]),
    false,
  );
});

test('a different barcode is never verified', () => {
  assert.equal(
    verified([spotify({ spotifyTrackId: 't1' })], [musicbrainz({ position: 1, barcode: '124' })]),
    false,
  );
});

test('out-of-order releases are verified by recording identity, not Spotify position', () => {
  // Waning Moon exposed this class of bug: Spotify and MusicBrainz publish the
  // same recordings in a different order. Both tracks have the same duration,
  // so duration alone cannot say which ISRC belongs at which MB position.
  const spotifyRows = [
    spotify({ spotifyTrackId: 't1', recordingMbid: 'recording-b' }),
    spotify({ spotifyTrackId: 't2', recordingMbid: 'recording-a' }),
  ];
  const musicbrainzRows = [
    musicbrainz({ position: 1, recordingMbid: 'recording-a' }),
    musicbrainz({ position: 2, recordingMbid: 'recording-b' }),
  ];
  assert.equal(verified(spotifyRows, musicbrainzRows), true);
});

test('matching durations do not manufacture alignment without recording evidence', () => {
  assert.equal(
    verified(
      [
        spotify({ spotifyTrackId: 't1', recordingMbid: 'not-on-release' }),
        spotify({ spotifyTrackId: 't2' }),
      ],
      [musicbrainz({ position: 1 }), musicbrainz({ position: 2 })],
    ),
    false,
  );
});
