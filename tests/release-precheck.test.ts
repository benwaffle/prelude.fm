import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artistMatchFrom,
  artistRole,
  assemblePrecheck,
  candidateGroups,
  classicalChecklist,
  creditMatch,
  existingVerdict,
  likeTitled,
  type ArtistSuggestion,
  type LookupState,
  type PrecheckGroupHit,
  type PrecheckIsrcs,
  type PrecheckReleaseHit,
} from '../app/lib/release-precheck';
import { seedArtists, titleLikeness, type ReleaseSeed } from '../app/lib/release-seed';
import { rankMissingReleases } from '../app/lib/contribution-list';
import type { MissingRelease } from '../app/lib/musicbrainz-contributions';

const bach = { spotifyId: 'sp-bach', name: 'Johann Sebastian Bach' };
const gould = { spotifyId: 'sp-gould', name: 'Glenn Gould' };

function seed(overrides: Partial<ReleaseSeed> = {}): ReleaseSeed {
  return {
    albumId: 'album-1',
    title: 'Glenn Gould plays Bach: The Well-Tempered Clavier Books I & II, BWV 846-893',
    upc: '886443621404',
    source: 'spotify',
    albumArtists: [bach, gould],
    tracks: [1, 2, 3].map((position) => ({
      disc: 1,
      position,
      title: `Prelude and Fugue No. ${position} in C Major, BWV 846: I. Prelude`,
      durationMs: 60_000 * position,
      isrc: `USSM1060282${position}`,
      artists: [bach, gould],
    })),
    ...overrides,
  };
}

// Bach resolved as composer, Gould as performer; `suggestion` is hoisted.
const ARTISTS: ArtistSuggestion[] = [suggestion(bach, 'composer'), suggestion(gould, 'performer')];
const done = <T>(value: T): LookupState<T> => ({ state: 'done', value });
const noIsrcs = done<PrecheckIsrcs>({ asked: 3, withoutIsrc: 0, hits: [] });

function release(overrides: Partial<PrecheckReleaseHit> = {}): PrecheckReleaseHit {
  return {
    mbid: 'rel-1',
    title: 'Glenn Gould Plays Bach: The Well-Tempered Clavier Books I & II',
    artist: 'Johann Sebastian Bach, Glenn Gould',
    date: '2012',
    country: 'XE',
    barcode: '887254126928',
    trackCount: 96,
    media: 4,
    groupMbid: 'rg-1',
    groupTitle: 'Glenn Gould Plays Bach: The Well-Tempered Clavier Books I & II',
    artistMbids: ['mb-sp-bach', 'mb-sp-gould'],
    likeness: 'similar',
    ...overrides,
  };
}

test('title likeness ignores case and punctuation, and tolerates an added catalogue range', () => {
  assert.equal(titleLikeness('Bach: Goldberg Variations', 'bach - goldberg variations'), 'same');
  assert.equal(
    titleLikeness(
      'Glenn Gould plays Bach: The Well-Tempered Clavier Books I & II, BWV 846-893',
      'Glenn Gould Plays Bach: The Well-Tempered Clavier Books I & II',
    ),
    'similar',
  );
  assert.equal(
    titleLikeness('Glenn Gould plays Bach: The Well-Tempered Clavier', 'Glenn Gould Plays Bach'),
    'different',
  );
});

test('a title that swaps a word is a different album, not an edition', () => {
  assert.equal(
    titleLikeness('The 99 Most Essential Allegros', 'The 99 Most Essential Chants'),
    'different',
  );
  assert.equal(
    titleLikeness(
      'Bach: Well Tempered Clavier (Books I & II, Complete)',
      'The Well-Tempered Clavier, Books I & II',
    ),
    'similar',
  );
});

test('a hit credit is compared with our performers, not just the composer', () => {
  assert.equal(creditMatch(['mb-sp-bach', 'mb-sp-gould'], ARTISTS), 'performer');
  assert.equal(creditMatch(['mb-sp-bach'], ARTISTS), 'composer-only');
  assert.equal(creditMatch(['mb-sp-bach', 'mb-schiff'], ARTISTS), 'other-artists');
  assert.equal(creditMatch([], ARTISTS), 'unknown');
  // Our performer is unidentified, so a stranger in the credit could be them.
  const unresolved = [suggestion(bach, 'composer'), suggestion(gould, 'couldnt-tell', false)];
  assert.equal(creditMatch(['mb-sp-bach', 'mb-schiff'], unresolved), 'unknown');
});

test('a same-titled group by another performer is not an edition of this album', () => {
  const group = (artistMbids: string[]): PrecheckGroupHit => ({
    mbid: 'rg-wtc',
    title: 'Glenn Gould plays Bach: The Well-Tempered Clavier Books I & II',
    artist: '',
    firstReleaseDate: null,
    primaryType: 'Album',
    artistMbids,
    likeness: 'similar',
  });
  assert.equal(
    existingVerdict(seed(), done([]), done([group(['mb-sp-bach', 'mb-schiff'])]), noIsrcs, ARTISTS)
      .verdict,
    'looks-new',
  );
  const composerOnly = existingVerdict(
    seed(),
    done([]),
    done([group(['mb-sp-bach'])]),
    noIsrcs,
    ARTISTS,
  );
  assert.equal(composerOnly.verdict, 'maybe-edition');
  assert.match(composerOnly.headline, /^Couldn't tell/);
  assert.equal(composerOnly.links.length, 1);
});

test('search hits with a different title are dropped', () => {
  const hits = likeTitled('Brendel plays Mozart', [
    { title: 'Brendel Plays Mozart' },
    { title: 'Mozart: Piano Concertos' },
  ]);
  assert.deepEqual(
    hits.map((hit) => [hit.title, hit.likeness]),
    [['Brendel Plays Mozart', 'same']],
  );
});

test('a same-titled release with the same track count is a possible duplicate', () => {
  const album = seed();
  const verdict = existingVerdict(
    album,
    done([release({ title: album.title, likeness: 'same', trackCount: 3, barcode: null })]),
    done([]),
    noIsrcs,
    ARTISTS,
  );
  assert.equal(verdict.verdict, 'possible-duplicate');
  assert.deepEqual(
    verdict.links.map((link) => link.href),
    ['https://musicbrainz.org/release/rel-1'],
  );
});

test('a similar release group means a new edition, and links the group', () => {
  const group: PrecheckGroupHit = {
    mbid: 'rg-1',
    title: 'Glenn Gould Plays Bach: The Well-Tempered Clavier Books I & II',
    artist: 'Bach, Gould',
    firstReleaseDate: '2012',
    primaryType: 'Album',
    artistMbids: ['mb-sp-bach', 'mb-sp-gould'],
    likeness: 'similar',
  };
  const verdict = existingVerdict(seed(), done([release()]), done([group]), noIsrcs, ARTISTS);
  assert.equal(verdict.verdict, 'new-edition');
  assert.deepEqual(
    verdict.links.map((link) => link.href),
    ['https://musicbrainz.org/release-group/rg-1'],
  );
});

test('recordings found by ISRC on a same-titled group count as a new edition; other groups do not', () => {
  const isrcs = done<PrecheckIsrcs>({
    asked: 3,
    withoutIsrc: 0,
    hits: [
      {
        isrc: 'USSM10602821',
        recordingMbid: 'rec-1',
        recordingTitle: 'Prelude',
        groups: [
          {
            mbid: 'rg-same',
            title: 'Glenn Gould Plays Bach: The Well-Tempered Clavier Books I & II',
          },
          { mbid: 'rg-other', title: 'The Complete Original Jacket Collection' },
        ],
      },
    ],
  });
  const album = seed();
  assert.deepEqual(
    candidateGroups(album, [], [], isrcs.state === 'done' ? isrcs.value.hits : [], ARTISTS).map(
      (group) => [group.mbid, group.via],
    ),
    [['rg-same', 'recordings']],
  );
  const verdict = existingVerdict(album, done([]), done([]), isrcs, ARTISTS);
  assert.equal(verdict.verdict, 'new-edition');
  assert.match(verdict.headline, /1 of its recordings already exist/);
});

test('recordings on unrelated albums only say the recordings exist', () => {
  const isrcs = done<PrecheckIsrcs>({
    asked: 3,
    withoutIsrc: 0,
    hits: [
      {
        isrc: 'USSM10602821',
        recordingMbid: 'rec-1',
        recordingTitle: 'Prelude',
        groups: [{ mbid: 'rg-other', title: 'Relaxing Piano Classics' }],
      },
    ],
  });
  assert.equal(
    existingVerdict(seed(), done([]), done([]), isrcs, ARTISTS).verdict,
    'recordings-exist',
  );
});

test('nothing found is "looks new" only when every lookup ran', () => {
  assert.equal(existingVerdict(seed(), done([]), done([]), noIsrcs, ARTISTS).verdict, 'looks-new');
  const failed = existingVerdict(
    seed(),
    { state: 'failed', error: '503 after 6 attempts' },
    done([]),
    noIsrcs,
    ARTISTS,
  );
  assert.equal(failed.verdict, 'couldnt-tell');
  assert.match(failed.headline, /Release search failed \(503 after 6 attempts\)/);
  const skipped = existingVerdict(
    seed(),
    done([]),
    done([]),
    {
      state: 'skipped',
      reason: 'Spotify gives no ISRCs for this album',
    },
    ARTISTS,
  );
  assert.equal(skipped.verdict, 'couldnt-tell');
});

test('artist matches: a Spotify link wins; otherwise only a unique exact name is suggested', () => {
  const gouldMb = {
    mbid: 'mb-gould',
    name: 'Glenn Gould',
    disambiguation: 'pianist',
    type: 'Person',
  };
  const other = {
    mbid: 'mb-gould-2',
    name: 'Glenn Gould',
    disambiguation: 'drummer',
    type: 'Person',
  };
  const skipped = { state: 'skipped', reason: 'linked' } as const;
  assert.deepEqual(artistMatchFrom('Glenn Gould', [gouldMb, gouldMb], skipped), {
    state: 'linked',
    artist: gouldMb,
  });
  assert.equal(artistMatchFrom('Glenn Gould', [gouldMb, other], skipped).state, 'several-linked');
  assert.deepEqual(
    artistMatchFrom('Glenn Gould', [], done([gouldMb, { ...other, name: 'Glen Gold' }])),
    {
      state: 'name-match',
      artist: gouldMb,
    },
  );
  assert.equal(artistMatchFrom('Glenn Gould', [], done([gouldMb, other])).state, 'ambiguous');
  assert.equal(artistMatchFrom('Glenn Gould', [], done([])).state, 'not-found');
  assert.deepEqual(artistMatchFrom('Glenn Gould', [], { state: 'failed', error: 'x' }), {
    state: 'failed',
    error: 'x',
  });
});

test('artist roles come from our cache first, then MusicBrainz, else "couldn\'t tell"', () => {
  const blank = { composerWorks: 0, performerCredits: 0, type: 'Person', disambiguation: null };
  assert.equal(artistRole({ ...blank, composerWorks: 12 }).role, 'composer');
  assert.equal(artistRole({ ...blank, performerCredits: 3 }).role, 'performer');
  assert.equal(
    artistRole({ ...blank, composerWorks: 1, performerCredits: 3 }).role,
    'composer-and-performer',
  );
  assert.equal(artistRole({ ...blank, type: 'Orchestra' }).role, 'performer');
  assert.equal(
    artistRole({ ...blank, disambiguation: 'American score composer and conductor' }).role,
    'composer-and-performer',
  );
  assert.equal(artistRole({ ...blank, disambiguation: 'classical composer' }).role, 'composer');
  assert.equal(artistRole(blank).role, 'couldnt-tell');
  assert.equal(artistRole(null).role, 'couldnt-tell');
});

function suggestion(
  artist: { spotifyId: string; name: string },
  role: ArtistSuggestion['role'],
  linked = true,
): ArtistSuggestion {
  return {
    ...artist,
    tracks: 3,
    onAlbum: true,
    match: linked
      ? {
          state: 'linked',
          artist: {
            mbid: `mb-${artist.spotifyId}`,
            name: artist.name,
            disambiguation: null,
            type: null,
          },
        }
      : { state: 'not-found' },
    role,
    roleWhy: '',
  };
}

test('the checklist flags a composer credited alongside performers', () => {
  const items = classicalChecklist(
    seed(),
    [suggestion(bach, 'composer'), suggestion(gould, 'performer')],
    { verdict: 'looks-new', headline: '', links: [] },
    noIsrcs,
  );
  const keys = items.map((item) => item.key);
  assert.ok(keys.includes('composer-with-performers'));
  assert.ok(!keys.includes('composer-unknown'));
  assert.match(
    items.find((item) => item.key === 'composer-with-performers')!.text,
    /On 3 of 3 tracks/,
  );
});

test('the checklist says it could not tell when no credited artist is a known composer', () => {
  const items = classicalChecklist(
    seed(),
    [suggestion(bach, 'couldnt-tell', false), suggestion(gould, 'performer')],
    { verdict: 'looks-new', headline: '', links: [] },
    noIsrcs,
  );
  const keys = items.map((item) => item.key);
  assert.ok(keys.includes('composer-unknown'));
  assert.ok(keys.includes('unlinked-artists'));
  assert.ok(!keys.includes('composer-with-performers'));
});

test('the checklist flags title shapes, discs, missing ISRCs and a Various Artists album', () => {
  const album = seed({
    albumArtists: [{ spotifyId: 'va', name: 'Various Artists' }],
    tracks: [
      { disc: 1, position: 1, title: 'I. Allegro', durationMs: 1, isrc: null, artists: [bach] },
      {
        disc: 2,
        position: 1,
        title: 'Symphony No. 5 in C Minor, Op. 67 - II. Andante con moto',
        durationMs: 2,
        isrc: 'X',
        artists: [bach],
      },
      {
        disc: 2,
        position: 2,
        title: 'Clair de lune (Remastered 2015)',
        durationMs: 3,
        isrc: 'Y',
        artists: [bach],
      },
    ],
  });
  const keys = classicalChecklist(
    album,
    [suggestion(bach, 'composer')],
    { verdict: 'looks-new', headline: '', links: [] },
    noIsrcs,
  ).map((item) => item.key);
  for (const key of [
    'movement-without-work',
    'dash-separator',
    'store-suffix',
    'multi-disc',
    'missing-isrc',
    'various-artists',
  ]) {
    assert.ok(keys.includes(key), key);
  }
  assert.ok(!keys.includes('composer-with-performers'));
});

test('Various Artists is not offered as an artist to match', () => {
  const rows = seedArtists(seed({ albumArtists: [{ spotifyId: 'va', name: 'Various Artists' }] }));
  assert.deepEqual(
    rows.map((row) => [row.artist.name, row.tracks, row.onAlbum]),
    [
      ['Glenn Gould', 3, false],
      ['Johann Sebastian Bach', 3, false],
    ],
  );
});

test('an assembled pre-check carries the edition and reuse items for the human', () => {
  const precheck = assemblePrecheck({
    seed: seed(),
    searchedArtist: 'Johann Sebastian Bach',
    releases: done([release()]),
    groups: done([]),
    isrcs: done<PrecheckIsrcs>({
      asked: 3,
      withoutIsrc: 0,
      hits: [{ isrc: 'USSM10602821', recordingMbid: 'rec-1', recordingTitle: 'P', groups: [] }],
    }),
    artists: ARTISTS,
  });
  assert.equal(precheck.existing.verdict, 'new-edition');
  const keys = precheck.checklist.map((item) => item.key);
  assert.ok(keys.includes('attach-release-group'));
  assert.ok(keys.includes('reuse-recordings'));
});

test('missing releases rank by library tracks unblocked, then album size', () => {
  const row = (albumId: string, tracks: number): MissingRelease => ({
    albumId,
    albumTitle: albumId,
    year: null,
    upc: null,
    tracks,
    unanchored: tracks,
    reason: 'no release carries this barcode',
  });
  const rows = [row('huge-but-unclassical', 200), row('mid', 40), row('small', 10), row('tie', 50)];
  const ranked = rankMissingReleases(
    rows,
    new Map([
      ['mid', 30],
      ['small', 10],
      ['tie', 10],
    ]),
  );
  assert.deepEqual(
    ranked.map((entry) => [entry.albumId, entry.libraryTracks]),
    [
      ['mid', 30],
      ['tie', 10],
      ['small', 10],
      ['huge-but-unclassical', 0],
    ],
  );
  assert.deepEqual(
    rankMissingReleases(rows, null).map((entry) => [entry.albumId, entry.libraryTracks]),
    [
      ['huge-but-unclassical', null],
      ['tie', null],
      ['mid', null],
      ['small', null],
    ],
  );
});
