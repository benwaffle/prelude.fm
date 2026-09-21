import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diagnoseTracklist,
  findReleaseForAlbum,
  loneTrackFits,
  releaseFitsAlbum,
  tracklistAligns,
} from '../app/lib/musicbrainz-matching';
import type { MbRelease, MusicBrainzSource } from '../app/lib/musicbrainz-source';

type TrackRow = {
  spotifyId: string;
  title: string;
  discNumber: number;
  trackNumber: number;
  durationMs: number;
  isrc: string | null;
};

function spotifyTracks(durations: number[]): TrackRow[] {
  return durations.map((durationMs, index) => ({
    spotifyId: `t${index + 1}`,
    title: `Track ${index + 1}`,
    discNumber: 1,
    trackNumber: index + 1,
    durationMs,
    isrc: null,
  }));
}

function mbRelease(id: string, lengths: (number | null)[]): MbRelease {
  return {
    id,
    title: 'A Release',
    barcode: null,
    date: null,
    country: null,
    tracks: lengths.map((length, index) => ({
      medium: 1,
      position: index + 1,
      title: `Track ${index + 1}`,
      length,
      recording: {
        id: `r${index + 1}`,
        title: `Track ${index + 1}`,
        length,
        isrcs: [],
        works: [],
        credits: [],
        artistCredit: [],
      },
    })),
  };
}

/** A source that answers from canned data and counts what it was asked. */
function fakeSource(answers: Partial<MusicBrainzSource>): MusicBrainzSource & { calls: string[] } {
  const calls: string[] = [];
  const unimplemented = (name: string) => async () => {
    calls.push(name);
    throw new Error(`${name} not stubbed`);
  };
  return {
    calls,
    name: 'fake',
    releasesByBarcode: answers.releasesByBarcode ?? (async () => []),
    searchReleases: answers.searchReleases ?? (async () => []),
    releaseWithRecordings: answers.releaseWithRecordings ?? (async () => null),
    releaseRecordingIds: answers.releaseRecordingIds ?? (async () => []),
    recordingsByIsrc: answers.recordingsByIsrc ?? (async () => new Map()),
    recordingWorks: answers.recordingWorks ?? (async () => []),
    work: answers.work ?? unimplemented('work'),
    artist: answers.artist ?? unimplemented('artist'),
  } as MusicBrainzSource & { calls: string[] };
}

const album = { spotifyId: 'a1', title: 'A Release', upc: null, mbReleaseId: null };

/* ------------------------------------------------------- releaseFitsAlbum */

test('a release with the same durations in the same order fits', () => {
  assert.equal(
    releaseFitsAlbum(
      spotifyTracks([200_000, 300_000, 250_000]),
      mbRelease('r', [200_500, 299_000, 250_000]),
    ),
    true,
  );
});

test('a different track count never fits', () => {
  assert.equal(
    releaseFitsAlbum(
      spotifyTracks([200_000, 300_000]),
      mbRelease('r', [200_000, 300_000, 250_000]),
    ),
    false,
  );
});

test('one track well outside tolerance rejects the release', () => {
  assert.equal(
    releaseFitsAlbum(
      spotifyTracks([200_000, 300_000, 250_000]),
      mbRelease('r', [200_000, 320_000, 250_000]),
    ),
    false,
  );
});

test('a release MusicBrainz has not timed cannot be confirmed by duration', () => {
  // Title and track count alone would also match a different edition, so this
  // has to fail rather than pass on the strength of the two of them.
  assert.equal(
    releaseFitsAlbum(
      spotifyTracks([200_000, 300_000, 250_000]),
      mbRelease('r', [null, null, null]),
    ),
    false,
  );
});

test('a release timed well enough still fits when one track is missing a length', () => {
  const tracks = spotifyTracks([200_000, 300_000, 250_000, 180_000, 220_000]);
  const release = mbRelease('r', [200_000, 300_000, 250_000, 180_000, null]);
  assert.equal(releaseFitsAlbum(tracks, release), true);
});

/* --------------------------------------------------- findReleaseForAlbum */

test('a known release is used without spending a request', async () => {
  const source = fakeSource({});
  const match = await findReleaseForAlbum(source, { ...album, mbReleaseId: 'known' }, []);
  assert.deepEqual(match, { releaseMbid: 'known', matchedBy: 'known', requests: 0 });
});

test('one release carrying the barcode is the album', async () => {
  const source = fakeSource({ releasesByBarcode: async () => ['only'] });
  const match = await findReleaseForAlbum(source, { ...album, upc: '0709869024256' }, []);
  assert.equal(match.releaseMbid, 'only');
  assert.equal(match.requests, 1);
});

test('releases sharing a barcode are interchangeable when their recordings are', async () => {
  const source = fakeSource({
    releasesByBarcode: async () => ['eu', 'us'],
    releaseRecordingIds: async () => ['rec1', 'rec2'],
  });
  const match = await findReleaseForAlbum(source, { ...album, upc: '123' }, []);
  assert.equal(match.releaseMbid, 'eu');
});

test('releases sharing a barcode with different recordings are ambiguous', async () => {
  const source = fakeSource({
    releasesByBarcode: async () => ['eu', 'us'],
    releaseRecordingIds: async (id) => (id === 'eu' ? ['rec1'] : ['rec9']),
  });
  const match = await findReleaseForAlbum(source, { ...album, upc: '123' }, []);
  assert.equal(match.releaseMbid, null);
  assert.equal(match.releaseMbid === null && match.reason, 'ambiguous');
});

test('a release with no barcode is found by title and confirmed by duration', async () => {
  const tracks = spotifyTracks([200_000, 300_000, 250_000]);
  const source = fakeSource({
    searchReleases: async () => ['candidate'],
    releaseWithRecordings: async () => mbRelease('candidate', [200_000, 300_000, 250_000]),
  });
  const match = await findReleaseForAlbum(source, album, tracks);
  assert.equal(match.releaseMbid, 'candidate');
  assert.equal(match.releaseMbid !== null && match.matchedBy, 'title_duration');
});

test('a title match whose durations disagree is not the album', async () => {
  const tracks = spotifyTracks([200_000, 300_000, 250_000]);
  const source = fakeSource({
    searchReleases: async () => ['candidate'],
    releaseWithRecordings: async () => mbRelease('candidate', [111_000, 222_000, 333_000]),
  });
  const match = await findReleaseForAlbum(source, album, tracks);
  assert.equal(match.releaseMbid, null);
});

test('two editions that both fit are left unmatched rather than guessed between', async () => {
  const tracks = spotifyTracks([200_000, 300_000, 250_000]);
  const source = fakeSource({
    searchReleases: async () => ['edition-a', 'edition-b'],
    releaseWithRecordings: async (id) => mbRelease(id, [200_000, 300_000, 250_000]),
  });
  const match = await findReleaseForAlbum(source, album, tracks);
  assert.equal(match.releaseMbid, null);
  assert.equal(match.releaseMbid === null && match.reason, 'ambiguous');
});

/* --------------------------------------------------------- tracklistAligns */

function releaseTracks(lengths: (number | null)[]) {
  return lengths.map((length, index) => ({ medium: 1, position: index + 1, length }));
}

test('a tracklist in the same order with close durations aligns', () => {
  assert.equal(
    tracklistAligns(spotifyTracks([200_000, 300_000]), releaseTracks([200_500, 299_000])),
    true,
  );
});

test('transfer differences of several seconds still align', () => {
  // Measured on a real album: a CD master and its Spotify transfer ran from
  // three to ten seconds apart across the same twelve performances.
  assert.equal(
    tracklistAligns(
      spotifyTracks([490_693, 368_733, 263_880, 291_840]),
      releaseTracks([494_000, 375_000, 272_000, 302_000]),
    ),
    true,
  );
});

test('a tracklist of a different length does not align', () => {
  assert.equal(tracklistAligns(spotifyTracks([200_000]), releaseTracks([200_000, 300_000])), false);
});

test('one track wildly out of place fails the whole tracklist', () => {
  // Not "anchor the rest and drop this one": a track this far out means the
  // release is a different edition, and every position is then in doubt.
  assert.equal(
    tracklistAligns(
      spotifyTracks([200_000, 300_000, 250_000]),
      releaseTracks([200_000, 300_000, 600_000]),
    ),
    false,
  );
});

test('an empty album aligns with nothing', () => {
  assert.equal(tracklistAligns([], []), false);
});

test('a release with no durations aligns on shape alone', () => {
  // The release was already identified by barcode; the tracklist having the
  // same shape is then enough for position to mean something.
  assert.equal(
    tracklistAligns(spotifyTracks([200_000, 300_000]), releaseTracks([null, null])),
    true,
  );
});

/* ------------------------------------------------------------ loneTrackFits */

test('a lone track fits a position whose duration agrees closely', () => {
  assert.equal(
    loneTrackFits(
      { discNumber: 1, trackNumber: 11, durationMs: 133_066 },
      { medium: 1, position: 11, length: 134_000 },
    ),
    true,
  );
});

test('a lone track is held to a tighter tolerance than an aligned tracklist', () => {
  // Six seconds is fine when every other track on the album agrees; on its
  // own it is the difference between two performances.
  const track = { discNumber: 1, trackNumber: 11, durationMs: 133_066 };
  const releaseTrack = { medium: 1, position: 11, length: 139_500 };
  assert.equal(loneTrackFits(track, releaseTrack), false);
  assert.equal(tracklistAligns([track], [releaseTrack]), true);
});

test('a lone track cannot be placed against an untimed release track', () => {
  assert.equal(
    loneTrackFits(
      { discNumber: 1, trackNumber: 11, durationMs: 133_066 },
      { medium: 1, position: 11, length: null },
    ),
    false,
  );
});

test('a lone track with no counterpart at its position does not fit', () => {
  assert.equal(
    loneTrackFits({ discNumber: 1, trackNumber: 11, durationMs: 133_066 }, undefined),
    false,
  );
});

test('an album matching one medium of a multi-medium release aligns', () => {
  // A hybrid SACD is three mediums of the same content in MusicBrainz, so an
  // 18-track album meets a 54-track release. It is exactly medium one.
  const album = spotifyTracks([200_000, 300_000, 250_000]);
  const threeLayers = [1, 2, 3].flatMap((medium) =>
    [200_000, 300_000, 250_000].map((length, index) => ({
      medium,
      position: index + 1,
      length,
    })),
  );
  assert.equal(tracklistAligns(album, threeLayers), true);
});

test('a medium with the right count but wrong durations does not rescue it', () => {
  const album = spotifyTracks([200_000, 300_000, 250_000]);
  const twoDiscs = [1, 2].flatMap((medium) =>
    [900_000, 910_000, 920_000].map((length, index) => ({
      medium,
      position: index + 1,
      length,
    })),
  );
  assert.equal(tracklistAligns(album, twoDiscs), false);
});

test('a single-medium release of the wrong length still does not align', () => {
  assert.equal(tracklistAligns(spotifyTracks([200_000]), releaseTracks([200_000, 300_000])), false);
});

/* ------------------------------------------------------ diagnoseTracklist */

test('a rotated tracklist is recognised as reordered, not as different music', () => {
  // A real release: the same three recordings, shifted by one, durations
  // pairing off to a millisecond.
  const ours = spotifyTracks([176653, 235800, 194600]);
  const theirs = releaseTracks([194601, 176654, 235801]);
  assert.deepEqual(diagnoseTracklist(ours, theirs), { kind: 'reordered', matched: 3 });
});

test('a release with a different number of tracks says so', () => {
  const diagnosis = diagnoseTracklist(spotifyTracks([200_000]), releaseTracks([200_000, 300_000]));
  assert.deepEqual(diagnosis, { kind: 'different-length', ours: 1, theirs: 2 });
});

test('durations that pair off nowhere are different recordings', () => {
  const diagnosis = diagnoseTracklist(
    spotifyTracks([200_000, 300_000, 250_000]),
    releaseTracks([600_000, 700_000, 800_000]),
  );
  assert.equal(diagnosis.kind, 'different-recordings');
});

test('an album that lines up is not diagnosed at all', () => {
  assert.deepEqual(
    diagnoseTracklist(spotifyTracks([200_000, 300_000]), releaseTracks([200_500, 299_000])),
    { kind: 'aligned' },
  );
});

test('one duplicated duration cannot pair with the same track twice', () => {
  // Two tracks of the same length must consume two release tracks, not one.
  const diagnosis = diagnoseTracklist(
    spotifyTracks([200_000, 200_000, 900_000]),
    releaseTracks([200_000, 500_000, 500_000]),
  );
  assert.equal(diagnosis.kind, 'different-recordings');
});

test('a release Spotify flattened into one disc still aligns', () => {
  // MusicBrainz holds this as 9 tracks then 12; Spotify sells it as a single
  // run of 21. The totals agree, but track 10 has no disc 1 position 10.
  const album = spotifyTracks([100_000, 200_000, 300_000, 400_000]);
  const twoDiscs = [
    { medium: 1, position: 1, length: 100_000 },
    { medium: 1, position: 2, length: 200_000 },
    { medium: 2, position: 1, length: 300_000 },
    { medium: 2, position: 2, length: 400_000 },
  ];
  assert.equal(tracklistAligns(album, twoDiscs), true);
});

test('flattening does not rescue a tracklist in the wrong order', () => {
  const album = spotifyTracks([100_000, 200_000, 300_000, 400_000]);
  const shuffled = [
    { medium: 1, position: 1, length: 400_000 },
    { medium: 1, position: 2, length: 300_000 },
    { medium: 2, position: 1, length: 200_000 },
    { medium: 2, position: 2, length: 100_000 },
  ];
  assert.equal(tracklistAligns(album, shuffled), false);
});
