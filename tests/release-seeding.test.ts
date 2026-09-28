import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArtistSuggestion, PrecheckIsrcHit } from '../app/lib/release-precheck';
import type { ReleaseSeed, SeedTrack } from '../app/lib/release-seed';
import {
  editionsShapedLike,
  matchRecordings,
  planSeed,
  seedFields,
  seedPlanBaseline,
  trackCredit,
  type EditionTracklist,
} from '../app/lib/release-seeding';
import { compareRelease, type LandedTrack } from '../app/lib/release-corrections';

const handel = { spotifyId: 'sp-handel', name: 'George Frideric Handel' };
const haim = { spotifyId: 'sp-haim', name: 'Emmanuelle Haïm' };
const astree = { spotifyId: 'sp-astree', name: "Le Concert d'Astrée" };

function suggestion(
  artist: { spotifyId: string; name: string },
  role: ArtistSuggestion['role'],
  mbid: string | null,
): ArtistSuggestion {
  return {
    ...artist,
    tracks: 2,
    onAlbum: true,
    match: mbid
      ? { state: 'linked', artist: { mbid, name: artist.name, disambiguation: null, type: null } }
      : { state: 'not-found' },
    role,
    roleWhy: '',
  };
}

const ARTISTS = [
  suggestion(handel, 'composer', 'mb-handel'),
  suggestion(haim, 'performer', 'mb-haim'),
  suggestion(astree, 'performer', null),
];

function track(disc: number, position: number, overrides: Partial<SeedTrack> = {}): SeedTrack {
  return {
    disc,
    position,
    title: `Il trionfo, HWV 46a, Pt. ${disc}: No. ${position} Aria`,
    durationMs: 100_000 + position * 1_000,
    isrc: `FR0000000${disc}${position}`,
    artists: [handel, haim, astree],
    ...overrides,
  };
}

function seed(tracks: SeedTrack[] = [track(1, 1), track(1, 2), track(2, 1)]): ReleaseSeed {
  return {
    albumId: 'album-1',
    title: 'Handel: Il trionfo del Tempo e del disinganno, HWV 46a',
    upc: '0190295855678',
    source: 'spotify',
    releaseDate: '2007-05-14',
    label: 'Virgin Classics',
    albumArtists: [haim, handel, astree],
    tracks,
  };
}

const hit = (isrc: string, recordingMbid: string, lengthMs?: number | null): PrecheckIsrcHit => ({
  isrc,
  recordingMbid,
  recordingTitle: 't',
  lengthMs,
  groups: [],
});

function edition(
  releaseMbid: string,
  entries: [number, number, string, number | null, string?][],
): EditionTracklist {
  return {
    releaseMbid,
    releaseTitle: 'Il trionfo del Tempo e del Disinganno',
    tracks: entries.map(([medium, position, recordingMbid, lengthMs, title]) => ({
      medium,
      position,
      recordingMbid,
      lengthMs,
      title: title ?? `Il trionfo, HWV 46a, Pt. ${medium}: No. ${position} Aria`,
    })),
  };
}

test('an ISRC with exactly one recording of a matching length is pre-filled', () => {
  const decisions = matchRecordings(
    seed([track(1, 1)]),
    [hit('FR000000011', 'rec-a', 101_500)],
    [],
  );
  assert.deepEqual(decisions.get('1-1'), {
    state: 'matched',
    recordingMbid: 'rec-a',
    via: 'isrc',
    why: 'ISRC FR000000011',
  });
});

test('an ISRC shared by several recordings, or of the wrong length, is left empty', () => {
  const shared = matchRecordings(
    seed([track(1, 1)]),
    [hit('FR000000011', 'rec-a'), hit('FR000000011', 'rec-b')],
    [],
  ).get('1-1');
  assert.equal(shared?.state, 'ambiguous');
  assert.deepEqual(shared?.state === 'ambiguous' && shared.candidates, ['rec-a', 'rec-b']);
  const long = matchRecordings(seed([track(1, 1)]), [hit('FR000000011', 'rec-a', 200_000)], []).get(
    '1-1',
  );
  assert.equal(long?.state, 'ambiguous');
  assert.match(long?.state === 'ambiguous' ? long.reason : '', /200s long, the track 101s/);
});

test('a new edition pre-fills by position when length and title agree', () => {
  const decisions = matchRecordings(
    seed(),
    [],
    [
      edition('rel-old', [
        [1, 1, 'rec-1', 101_000],
        [1, 2, 'rec-2', 150_000],
        [2, 1, 'rec-3', 101_000, 'Something else entirely'],
      ]),
    ],
  );
  assert.equal(decisions.get('1-1')?.state, 'matched');
  assert.equal(decisions.get('1-2')?.state, 'ambiguous', 'length disagrees');
  assert.equal(decisions.get('2-1')?.state, 'ambiguous', 'title disagrees');
});

test('ISRC and position must agree; editions that disagree leave the track empty', () => {
  const both = matchRecordings(
    seed([track(1, 1)]),
    [hit('FR000000011', 'rec-1')],
    [edition('rel-old', [[1, 1, 'rec-1', 101_000]])],
  ).get('1-1');
  assert.equal(both?.state === 'matched' && both.via, 'isrc-and-position');

  const conflict = matchRecordings(
    seed([track(1, 1)]),
    [hit('FR000000011', 'rec-x')],
    [edition('rel-old', [[1, 1, 'rec-1', 101_000]])],
  ).get('1-1');
  assert.equal(conflict?.state, 'ambiguous');

  const editionsDisagree = matchRecordings(
    seed([track(1, 1)]),
    [],
    [edition('rel-a', [[1, 1, 'rec-1', 101_000]]), edition('rel-b', [[1, 1, 'rec-2', 101_000]])],
  ).get('1-1');
  assert.equal(editionsDisagree?.state, 'ambiguous');
});

test('a recording that would land on two tracks is pulled from both', () => {
  const decisions = matchRecordings(
    seed([track(1, 1), track(1, 2)]),
    [hit('FR000000011', 'rec-same'), hit('FR000000012', 'rec-same')],
    [],
  );
  assert.equal(decisions.get('1-1')?.state, 'ambiguous');
  assert.equal(decisions.get('1-2')?.state, 'ambiguous');
});

test('tracks nobody knows get no recording, with the reason', () => {
  const none = matchRecordings(seed([track(1, 1, { isrc: null })]), [], []).get('1-1');
  assert.deepEqual(none, {
    state: 'none',
    reason: 'Spotify gives no ISRC, and no existing release lines up',
  });
});

test('only editions with the same discs and track counts are used for positions', () => {
  const same = edition('same', [
    [1, 1, 'a', 1],
    [1, 2, 'b', 1],
    [2, 1, 'c', 1],
  ]);
  const oneDisc = edition('one-disc', [
    [1, 1, 'a', 1],
    [1, 2, 'b', 1],
    [1, 3, 'c', 1],
  ]);
  assert.deepEqual(
    editionsShapedLike(seed(), [same, oneDisc]).map((entry) => entry.releaseMbid),
    ['same'],
  );
});

test('track credit is the composer when one is known, else Spotify’s credit unchanged', () => {
  const byKey = new Map(ARTISTS.map((artist) => [artist.spotifyId!, artist]));
  assert.deepEqual(trackCredit([handel, haim, astree], byKey), {
    credit: [{ name: 'George Frideric Handel', mbid: 'mb-handel', joinPhrase: '' }],
    shape: 'composer-only',
  });
  assert.deepEqual(trackCredit([haim, astree], byKey), {
    credit: [
      { name: 'Emmanuelle Haïm', mbid: 'mb-haim', joinPhrase: ', ' },
      { name: "Le Concert d'Astrée", mbid: null, joinPhrase: '' },
    ],
    shape: 'as-spotify',
  });
  assert.equal(trackCredit([handel, haim, astree], byKey, 'performers').shape, 'performers-only');
});

function plan(strongGroups = [{ mbid: 'rg-1', title: 'Il trionfo' }]) {
  return planSeed({
    seed: seed(),
    artists: ARTISTS,
    isrcHits: [hit('FR000000011', 'rec-1', 101_000)],
    strongGroups,
    editions: [],
  });
}

test('the release group is seeded only when exactly one strong group qualifies', () => {
  assert.equal(plan().releaseGroupMbid, 'rg-1');
  const two = plan([
    { mbid: 'rg-1', title: 'A' },
    { mbid: 'rg-2', title: 'B' },
  ]);
  assert.equal(two.releaseGroupMbid, null);
  assert.match(two.releaseGroupNote ?? '', /2 existing release groups qualify/);
  assert.equal(plan([]).releaseGroupMbid, null);
});

test('seed fields use the documented names, and only matched tracks carry a recording', () => {
  const fields = seedFields(plan());
  const get = (name: string) => fields.filter(([key]) => key === name).map(([, value]) => value);
  assert.deepEqual(get('name'), ['Handel: Il trionfo del Tempo e del disinganno, HWV 46a']);
  assert.deepEqual(get('status'), ['official']);
  assert.deepEqual(get('packaging'), ['None']);
  assert.deepEqual(get('barcode'), ['0190295855678']);
  assert.deepEqual(get('release_group'), ['rg-1']);
  assert.deepEqual(get('events.0.date.year'), ['2007']);
  assert.deepEqual(get('events.0.date.month'), ['5']);
  assert.deepEqual(get('events.0.date.day'), ['14']);
  assert.deepEqual(get('labels.0.name'), ['Virgin Classics']);
  assert.deepEqual(get('artist_credit.names.0.mbid'), ['mb-haim']);
  assert.deepEqual(get('artist_credit.names.2.artist.name'), ["Le Concert d'Astrée"]);
  assert.deepEqual(get('artist_credit.names.2.mbid'), []);
  assert.deepEqual(get('mediums.0.track.0.recording'), ['rec-1']);
  assert.deepEqual(get('mediums.0.track.1.recording'), []);
  assert.deepEqual(get('mediums.1.track.0.number'), ['1']);
  assert.deepEqual(get('mediums.0.track.0.length'), ['101000']);
  assert.deepEqual(get('mediums.0.track.0.artist_credit.names.0.mbid'), ['mb-handel']);
  assert.deepEqual(get('urls.0.url'), ['https://open.spotify.com/album/album-1']);
  assert.deepEqual(get('urls.0.link_type'), ['85']);
  const [note] = get('edit_note');
  assert.match(note, /https:\/\/open\.spotify\.com\/album\/album-1/);
  assert.match(note, /1\.1: https:\/\/musicbrainz\.org\/recording\/rec-1 \(ISRC FR000000011\)/);
  assert.match(note, /Seeded by prelude\.fm, reviewed by a human before submitting\.$/);
  assert.deepEqual(plan().counts, { tracks: 3, prefilled: 1, ambiguous: 0, none: 2 });
});

test('a correction record against our own seed counts pre-filled recordings kept or replaced', () => {
  const seeded = plan();
  const baseline = seedPlanBaseline(seeded);
  const landedTrack = (disc: number, position: number, recordingMbid: string): LandedTrack => {
    const planned = seeded.tracks.find((t) => t.disc === disc && t.position === position)!;
    return {
      medium: disc,
      position,
      title: planned.title,
      lengthMs: planned.lengthMs,
      artists: [{ mbid: 'mb-handel', name: 'Handel' }],
      // A new recording copies the track credit.
      recording: {
        mbid: recordingMbid,
        title: planned.title,
        artists: [{ mbid: 'mb-handel', name: 'Handel' }],
        isrcs: [],
      },
    };
  };
  const landed = {
    mbid: 'release-new',
    title: seeded.title,
    artists: [
      { mbid: 'mb-haim', name: 'Emmanuelle Haïm' },
      { mbid: 'mb-handel', name: 'Handel' },
      { mbid: 'mb-astree', name: "Le Concert d'Astrée" },
    ],
    releaseGroup: { mbid: 'rg-1', title: 'Il trionfo', otherReleases: 1 },
    media: 2,
    tracks: [landedTrack(1, 1, 'rec-1'), landedTrack(1, 2, 'rec-new'), landedTrack(2, 1, 'rec-2')],
  };
  const origins = new Map([
    ['rec-1', 'reused' as const],
    ['rec-new', 'created' as const],
    ['rec-2', 'created' as const],
  ]);
  const record = compareRelease({
    seed: baseline,
    baselineSource: 'prelude-seed',
    landed,
    origins,
    composers: 1,
    seededReleaseGroup: seeded.releaseGroupMbid,
  });
  assert.equal(record.recordings.seededKept, 1);
  assert.equal(record.recordings.seededReplaced, 0);
  // The seeded group, the pre-filled recording and MBID-credited artists are not corrections.
  assert.deepEqual(record.corrections, []);

  const swapped = compareRelease({
    seed: baseline,
    baselineSource: 'prelude-seed',
    landed: { ...landed, tracks: [landedTrack(1, 1, 'rec-other'), ...landed.tracks.slice(1)] },
    origins: new Map([...origins, ['rec-other', 'reused' as const]]),
    composers: 1,
    seededReleaseGroup: seeded.releaseGroupMbid,
  });
  assert.equal(swapped.recordings.seededReplaced, 1);
  assert.deepEqual(swapped.corrections, ['recordings-reused', 'seeded-recordings-replaced']);
});
