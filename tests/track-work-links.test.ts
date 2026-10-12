import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanTrackTitle,
  confirmedPart,
  confirmWork,
  linkDecision,
  unlinkSharedMatches,
  type TrackWorkMatch,
} from '../app/lib/track-work-links';
import type { ProposalCandidate, ProposalTarget, WorkProposal } from '../app/lib/work-proposals';

test('Spotify titles are read the way MusicBrainz writes them', () => {
  assert.equal(
    cleanTrackTitle('Handel: Keyboard Sonata in C Major, HWV 577', ['George Frideric Handel']),
    'Keyboard Sonata in C Major, HWV 577',
  );
  assert.equal(
    cleanTrackTitle(
      'Le quattro stagioni, Op. 8 - Concerto No. 1 in E Major, RV 269: III. Danza pastorale: Allegro',
      [],
    ),
    'Le quattro stagioni, Op. 8: Concerto No. 1 in E Major, RV 269: III. Danza pastorale, Allegro',
  );
  assert.equal(
    cleanTrackTitle('Concerto N.1 In Re Minore BWV 1052 - Allegro risoluto', []),
    'Concerto N.1 In Re Minore BWV 1052: Allegro risoluto',
  );
  assert.equal(
    cleanTrackTitle('Piano Sonata No. 8, Op. 13: III. Rondo - Remastered 2015', []),
    'Piano Sonata No. 8, Op. 13: III. Rondo',
  );
  // A colon prefix that is not a credited artist stays.
  assert.equal(
    cleanTrackTitle('Carnaval, Op. 9: 15. Pantalon', ['Robert Schumann']),
    'Carnaval, Op. 9: 15. Pantalon',
  );
});

function proposal(overrides: Partial<WorkProposal> = {}): WorkProposal {
  return {
    workMbid: 'work-1',
    title: 'Suite in E major, HWV 430: IV. Air',
    parentTitle: null,
    composerName: 'George Frideric Handel',
    confidence: 'high',
    source: 'search',
    reasons: [],
    signals: {
      titleScore: 0.9,
      sharedNumbers: ['HWV 430'],
      composerMatch: 'George Frideric Handel',
      albumSiblings: 0,
      orderFits: false,
      movementMatch: true,
    },
    ...overrides,
  };
}

test('only a high-confidence match with a credited composer is linked', () => {
  assert.deepEqual(linkDecision(proposal()), { linked: true, heldBack: null });
  assert.equal(linkDecision(proposal({ confidence: 'medium' })).linked, false);
  const uncredited = proposal();
  uncredited.signals.composerMatch = null;
  assert.match(linkDecision(uncredited).heldBack ?? '', /not credited/);
});

test('two different tracks on one album never keep the same work', () => {
  const match = (titleScore: number): TrackWorkMatch => {
    const base = proposal();
    return { ...base, signals: { ...base.signals, titleScore }, linked: true, heldBack: null };
  };
  const rows = [
    { spotifyTrackId: 'a', title: 'Suite: IV. Air', match: match(0.9) },
    { spotifyTrackId: 'b', title: 'Suite: IV. Air (Variations)', match: match(0.7) },
  ];
  unlinkSharedMatches(rows);
  assert.equal(rows[0].match.linked, true);
  assert.equal(rows[1].match.linked, false);

  // The same title twice is a deliberate repeat, like five conductors' Fifths.
  const repeat = [
    { spotifyTrackId: 'a', title: 'Symphony No. 5: I. Allegro', match: match(0.9) },
    { spotifyTrackId: 'b', title: 'Symphony No. 5: I. Allegro', match: match(0.9) },
  ];
  unlinkSharedMatches(repeat);
  assert.ok(repeat.every((row) => row.match.linked));
});

const target = (title: string): ProposalTarget => ({
  recordingMbid: 'track-1',
  title,
  medium: 1,
  position: 1,
  artistNames: ['Johann Sebastian Bach', 'Hilary Hahn'],
  releaseComposers: [],
  siblings: [],
});

const konzert = {
  workMbid: 'bwv-1042',
  title: 'Konzert für Violine und Orchester E-Dur, BWV 1042',
  composerName: 'Johann Sebastian Bach',
  catalogueNumbers: ['BWV 1042'],
};

const part = (n: number, title: string): ProposalCandidate => ({
  workMbid: `bwv-1042-${n}`,
  title: `Konzert für Violine und Orchester E-Dur, BWV 1042: ${title}`,
  parentMbid: 'bwv-1042',
  parentTitle: konzert.title,
  orderingKey: n,
  composerName: 'Johann Sebastian Bach',
  aliases: [],
  source: 'album',
});

const parts = [part(1, 'I. Allegro'), part(2, 'II. Adagio'), part(3, 'III. Allegro assai')];

test('catalogue number and composer confirm a work whatever language MusicBrainz titles it in', () => {
  const title = 'Concerto No. 2 in E Major for Violin and Strings, BWV 1042: I. Allegro';
  const confirmed = confirmWork(title, ['Johann Sebastian Bach'], konzert);
  assert.ok(confirmed);
  const match = confirmedPart(target(title), confirmed, parts);
  assert.equal(match?.workMbid, 'bwv-1042-1');
  assert.equal(match?.linked, true);
});

test('a catalogue number alone, or a different one, confirms nothing', () => {
  assert.equal(
    confirmWork('Concerto, BWV 1042: I. Allegro', ['Hilary Hahn'], konzert),
    null,
    'composer not credited',
  );
  assert.equal(
    confirmWork('Concerto, BWV 1041: I. Allegro', ['Johann Sebastian Bach'], konzert),
    null,
  );
  // "op. 27 no. 2" needs both numbers.
  assert.equal(
    confirmWork('Sonata, Op. 27 No. 1: I. Andante', ['Ludwig van Beethoven'], {
      workMbid: 'moonlight',
      title: 'Piano Sonata no. 14, op. 27 no. 2',
      composerName: 'Ludwig van Beethoven',
      catalogueNumbers: ['op. 27 no. 2'],
    }),
    null,
  );
});

test('a confirmed work still needs the track to pick out exactly one part', () => {
  const confirmed = confirmWork('Concerto, BWV 1042: Adagio', ['Johann Sebastian Bach'], konzert)!;
  assert.equal(confirmedPart(target('Concerto, BWV 1042: Adagio'), confirmed, parts), null);
  assert.equal(confirmedPart(target('Concerto, BWV 1042: IV. Gigue'), confirmed, parts), null);
});

test('a part titled with its tempo is still picked out by its number and key', () => {
  const nocturnes = {
    workMbid: 'op-9',
    title: 'Nocturnes, op. 9',
    composerName: 'Fryderyk Chopin',
    catalogueNumbers: ['B. 54', 'op. 9'],
  };
  const nocturne = (n: number, title: string): ProposalCandidate => ({
    workMbid: `op-9-${n}`,
    title,
    parentMbid: 'op-9',
    parentTitle: nocturnes.title,
    orderingKey: n,
    composerName: 'Fryderyk Chopin',
    aliases: [],
    source: 'album',
  });
  const nocturneParts = [
    nocturne(1, 'Nocturne no. 1 in B‐flat minor, op. 9 no. 1: Larghetto'),
    nocturne(2, 'Nocturne no. 2 in E‐flat major, op. 9 no. 2: Andante'),
    nocturne(3, 'Nocturne no. 3 in B major, op. 9 no. 3: Allegretto'),
  ];
  const title = 'Nocturnes, Op. 9: No. 3 in B Major';
  const artists = ['Arthur Rubinstein', 'Frédéric Chopin'];
  const confirmed = confirmWork(title, artists, nocturnes);
  assert.ok(confirmed);
  const match = confirmedPart({ ...target(title), artistNames: artists }, confirmed, nocturneParts);
  assert.equal(match?.workMbid, 'op-9-3');
  assert.equal(
    confirmedPart(
      { ...target('Nocturnes, Op. 9: No. 4 in B Major'), artistNames: artists },
      confirmWork('Nocturnes, Op. 9: No. 4 in B Major', artists, nocturnes)!,
      nocturneParts,
    ),
    null,
  );
});
