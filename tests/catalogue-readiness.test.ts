import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NO_SUBMISSIONS,
  placeTrack,
  readinessFunnel,
  readinessTracksFrom,
  type ReadinessSubmissions,
  type ReadinessTrack,
} from '../app/lib/catalogue-readiness';
import { projectMusicBrainzLibrary } from '../app/lib/musicbrainz-library';
import type { MusicBrainzLibraryFacts } from '../app/lib/musicbrainz-library-facts';

let counter = 0;

function readyTrack(overrides: Partial<ReadinessTrack> = {}): ReadinessTrack {
  counter++;
  return {
    spotifyTrackId: `track-${counter}`,
    spotifyAlbumId: 'album-1',
    albumTitle: 'Album',
    isrc: 'GBAAA0000001',
    classification: 'classical',
    musicBrainzSaysClassical: true,
    link: { state: 'linked', recordingMbid: 'rec-1', recordingTitle: 'Recording', read: true },
    release: 'matched',
    releaseMbid: 'release-1',
    tracklist: 'aligned',
    works: [{ workMbid: 'work-1', title: 'Work', composer: 'named' }],
    ...overrides,
  };
}

const unlinked = { link: { state: 'none' as const }, works: [] };

test('a track with recording, work, composer and a classical classification is ready', () => {
  assert.equal(placeTrack(readyTrack()), null);
});

test('each blocked track is placed at its first missing step', () => {
  // No recording and no work: the recording is what is missing first.
  assert.equal(
    placeTrack(readyTrack({ ...unlinked, release: 'missing', releaseMbid: null, tracklist: null }))
      ?.bucket,
    'add-release',
  );
  // A recording without a work, and unclassified: the work comes first.
  assert.equal(
    placeTrack(readyTrack({ works: [], classification: 'unreviewed' }))?.bucket,
    'add-work-link',
  );
  // A work without a composer, and unclassified: the composer comes first.
  assert.equal(
    placeTrack(
      readyTrack({
        classification: 'uncertain',
        works: [{ workMbid: 'w', title: 'W', composer: 'missing' }],
      }),
    )?.bucket,
    'add-composer',
  );
});

test('an unlinked track is filed by what its album needs', () => {
  const place = (overrides: Partial<ReadinessTrack>) =>
    placeTrack(readyTrack({ ...unlinked, ...overrides }))?.bucket;
  assert.equal(place({ release: 'not_checked', tracklist: null }), 'release-not-looked-up');
  assert.equal(place({ release: 'ambiguous', tracklist: null }), 'pick-release');
  assert.equal(place({ tracklist: 'misaligned' }), 'fix-tracklist');
  assert.equal(place({ tracklist: 'not_read' }), 'release-not-read');
  // Aligned yet unlinked is something nothing here explains.
  assert.equal(place({ tracklist: 'aligned' }), 'recording-link-unknown');
  assert.equal(place({ link: { state: 'contested' } }), 'contested-isrc');
});

test('a recording or work our cache has not read is not an edit to make', () => {
  assert.equal(
    placeTrack(
      readyTrack({
        works: [],
        link: { state: 'linked', recordingMbid: 'r', recordingTitle: null, read: false },
      }),
    )?.bucket,
    'recording-not-read',
  );
  assert.equal(
    placeTrack(readyTrack({ works: [{ workMbid: 'w', title: null, composer: 'not_read' }] }))
      ?.bucket,
    'work-not-read',
  );
  assert.equal(
    placeTrack(readyTrack({ works: [{ workMbid: 'w', title: 'W', composer: 'level_unclear' }] }))
      ?.bucket,
    'work-level-unclear',
  );
});

test('the classical step separates missing evidence from an out-of-date decision', () => {
  assert.equal(
    placeTrack(readyTrack({ classification: 'unreviewed', musicBrainzSaysClassical: false }))
      ?.bucket,
    'add-classical-evidence',
  );
  assert.equal(
    placeTrack(readyTrack({ classification: 'uncertain', musicBrainzSaysClassical: true }))?.bucket,
    'classification-out-of-date',
  );
});

test('a medley needs a composer on every work', () => {
  assert.equal(
    placeTrack(
      readyTrack({
        works: [
          { workMbid: 'a', title: 'A', composer: 'named' },
          { workMbid: 'b', title: 'B', composer: 'missing' },
        ],
      }),
    )?.bucket,
    'add-composer',
  );
});

test('submitted fixes are counted as waiting, not outstanding', () => {
  const submissions: ReadinessSubmissions = {
    ...NO_SUBMISSIONS,
    releaseAlbums: new Set(['album-sent']),
    workLinkRecordings: new Set(['rec-sent']),
  };
  const funnel = readinessFunnel(
    [
      readyTrack({ ...unlinked, release: 'missing', spotifyAlbumId: 'album-sent' }),
      readyTrack({ ...unlinked, release: 'missing', spotifyAlbumId: 'album-other' }),
      readyTrack({
        works: [],
        link: { state: 'linked', recordingMbid: 'rec-sent', recordingTitle: null, read: true },
      }),
    ],
    submissions,
  );
  const buckets = funnel.steps.flatMap((step) => step.buckets);
  const addRelease = buckets.find((bucket) => bucket.key === 'add-release')!;
  assert.equal(addRelease.tracks, 2);
  assert.equal(addRelease.waiting, 1);
  const addWork = buckets.find((bucket) => bucket.key === 'add-work-link')!;
  assert.equal(addWork.tracks, 1);
  assert.equal(addWork.waiting, 1);
});

test('the funnel accounts for every track exactly once', () => {
  const tracks = [
    readyTrack(),
    readyTrack(),
    readyTrack({ classification: 'not_classical', ...unlinked }),
    readyTrack({ classification: 'unreviewed', ...unlinked, release: 'missing' }),
    readyTrack({ ...unlinked, release: 'missing', spotifyAlbumId: 'album-2' }),
    readyTrack({ ...unlinked, release: 'missing', spotifyAlbumId: 'album-2' }),
    readyTrack({ works: [] }),
    readyTrack({ works: [{ workMbid: 'w', title: 'W', composer: 'missing' }] }),
    readyTrack({ classification: 'uncertain', musicBrainzSaysClassical: false }),
  ];
  const funnel = readinessFunnel(tracks);

  assert.equal(funnel.total, 9);
  assert.equal(funnel.notClassical, 1);
  assert.equal(funnel.inScope, 8);
  assert.equal(funnel.ready, 2);
  assert.deepEqual(
    funnel.steps.map((step) => [step.key, step.reached, step.blocked]),
    [
      ['recording', 5, 3],
      ['work', 4, 1],
      ['composer', 3, 1],
      ['classical', 2, 1],
    ],
  );
  const blocked = funnel.steps.reduce((sum, step) => sum + step.blocked, 0);
  assert.equal(funnel.notClassical + blocked + funnel.ready, funnel.total);
  assert.equal(funnel.steps.at(-1)!.reached, funnel.ready);

  const addRelease = funnel.steps[0].buckets[0];
  assert.equal(addRelease.key, 'add-release');
  assert.equal(addRelease.groups, 2);
  // Biggest group first.
  assert.deepEqual(addRelease.examples[0], {
    label: 'Album',
    href: 'https://open.spotify.com/album/album-2',
    tracks: 2,
  });
});

test('buckets within a step are sorted by tracks unblocked', () => {
  const funnel = readinessFunnel([
    readyTrack({ ...unlinked, tracklist: 'misaligned' }),
    readyTrack({ ...unlinked, release: 'missing' }),
    readyTrack({ ...unlinked, release: 'missing' }),
  ]);
  assert.deepEqual(
    funnel.steps[0].buckets.map((bucket) => [bucket.key, bucket.tracks]),
    [
      ['add-release', 2],
      ['fix-tracklist', 1],
    ],
  );
});

function facts(): MusicBrainzLibraryFacts {
  const track = (id: string, trackNumber: number, spotifyAlbumId = 'album-1') => ({
    spotifyTrackId: id,
    title: id,
    spotifyAlbumId,
    discNumber: 1,
    trackNumber,
    durationMs: 100_000,
    popularity: null,
  });
  return {
    requestedTrackIds: ['ready', 'movement', 'unclassified', 'bare', 'unlinked'],
    classifications: [
      { spotifyTrackId: 'ready', state: 'classical', provenance: 'musicbrainz', reason: null },
      { spotifyTrackId: 'movement', state: 'classical', provenance: 'musicbrainz', reason: null },
      {
        spotifyTrackId: 'unclassified',
        state: 'unreviewed',
        provenance: 'musicbrainz',
        reason: null,
      },
      { spotifyTrackId: 'bare', state: 'classical', provenance: 'musicbrainz', reason: null },
      { spotifyTrackId: 'unlinked', state: 'unreviewed', provenance: 'musicbrainz', reason: null },
    ],
    providerAlbums: [
      {
        spotifyAlbumId: 'album-1',
        title: 'Album one',
        imageUrl: null,
        popularity: null,
        releaseResolution: { state: 'matched', releaseMbid: 'release-1' },
      },
      {
        spotifyAlbumId: 'album-2',
        title: 'Album two',
        imageUrl: null,
        popularity: null,
        releaseResolution: { state: 'missing' },
      },
    ],
    providerTracks: [
      track('ready', 1),
      track('movement', 2),
      track('unclassified', 3),
      track('bare', 4),
      track('unlinked', 1, 'album-2'),
    ],
    anchors: [
      {
        spotifyTrackId: 'ready',
        state: 'accepted',
        recordingMbid: 'rec-ready',
        matchedBy: 'isrc',
        isrc: null,
      },
      {
        spotifyTrackId: 'movement',
        state: 'accepted',
        recordingMbid: 'rec-movement',
        matchedBy: 'isrc',
        isrc: null,
      },
      {
        spotifyTrackId: 'unclassified',
        state: 'accepted',
        recordingMbid: 'rec-ready',
        matchedBy: 'isrc',
        isrc: null,
      },
      {
        spotifyTrackId: 'bare',
        state: 'accepted',
        recordingMbid: 'rec-bare',
        matchedBy: 'isrc',
        isrc: null,
      },
    ],
    mbRecordings: ['rec-ready', 'rec-movement', 'rec-bare'].map((mbid) => ({
      mbid,
      title: mbid,
      lengthMs: 100_000,
      detail: 'full' as const,
    })),
    mbRecordingWorks: [
      { recordingMbid: 'rec-ready', workMbid: 'sonata' },
      { recordingMbid: 'rec-movement', workMbid: 'movement' },
    ],
    mbWorks: [
      {
        mbid: 'sonata',
        title: 'Sonata',
        type: 'Sonata',
        parentMbid: null,
        orderingKey: null,
        composerMbid: 'composer',
        detail: 'full',
      },
      {
        // Titled as a part of a parent that has no composer of its own:
        // the player files it under the parent and shows no composer.
        mbid: 'movement',
        title: 'Suite: I. Prelude',
        type: null,
        parentMbid: 'suite',
        orderingKey: 1,
        composerMbid: 'composer',
        detail: 'full',
      },
      {
        mbid: 'suite',
        title: 'Suite',
        type: 'Suite',
        parentMbid: null,
        orderingKey: null,
        composerMbid: null,
        detail: 'full',
      },
    ],
    mbWorkCatalogues: [],
    mbArtists: [
      {
        mbid: 'composer',
        name: 'Composer',
        creditedName: null,
        sortName: null,
        type: 'Person',
        beginYear: null,
        endYear: null,
      },
    ],
    mbRecordingCredits: [],
    mbReleases: [
      {
        mbid: 'release-1',
        title: 'Release',
        date: null,
        country: null,
        spotifyFreeStreamingUrlState: 'unknown',
      },
    ],
    mbReleaseTracks: [1, 2, 3, 4].map((position) => ({
      releaseMbid: 'release-1',
      medium: 1,
      position,
      recordingMbid: position === 2 ? 'rec-movement' : position === 4 ? 'rec-bare' : 'rec-ready',
      title: null,
      lengthMs: 100_000,
    })),
  };
}

test('rows read from the player projection agree with what the player shows', () => {
  const input = facts();
  const rows = readinessTracksFrom(input, projectMusicBrainzLibrary(input));
  const byId = new Map(rows.map((row) => [row.spotifyTrackId, row]));

  assert.equal(rows.length, 5);
  assert.equal(placeTrack(byId.get('ready')!), null);
  // The player shows the suite's composer, which is missing, not the movement's.
  assert.deepEqual(byId.get('movement')!.works, [
    { workMbid: 'suite', title: 'Suite', composer: 'missing' },
  ]);
  assert.equal(placeTrack(byId.get('movement')!)?.bucket, 'add-composer');
  // Unreviewed but MusicBrainz types the work as a sonata: our stored
  // decision is what is behind, not MusicBrainz.
  assert.equal(byId.get('unclassified')!.musicBrainzSaysClassical, true);
  assert.equal(placeTrack(byId.get('unclassified')!)?.bucket, 'classification-out-of-date');
  assert.equal(placeTrack(byId.get('bare')!)?.bucket, 'add-work-link');
  // Unclassified and unlinked is still in scope, blocked on its release.
  assert.equal(byId.get('unlinked')!.release, 'missing');
  assert.equal(placeTrack(byId.get('unlinked')!)?.bucket, 'add-release');

  const funnel = readinessFunnel(rows);
  assert.equal(funnel.ready, 1);
  assert.equal(funnel.notClassical, 0);
  assert.equal(funnel.inScope, 5);
});
