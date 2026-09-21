import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findReleaseForAlbum,
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
