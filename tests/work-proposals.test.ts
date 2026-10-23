import assert from 'node:assert/strict';
import test from 'node:test';
import {
  flagSharedProposals,
  keyOf,
  movementNumber,
  numberRefs,
  proposeWork,
  type ProposalCandidate,
  type ProposalTarget,
} from '../app/lib/work-proposals';
import { proposalAlbums } from '../app/lib/work-proposals-view';

function target(overrides: Partial<ProposalTarget> = {}): ProposalTarget {
  return {
    recordingMbid: 'rec-1',
    title: 'Track',
    medium: 1,
    position: 1,
    artistNames: [],
    releaseComposers: [],
    siblings: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<ProposalCandidate> = {}): ProposalCandidate {
  return {
    workMbid: 'work-1',
    title: 'Work',
    parentMbid: null,
    parentTitle: null,
    orderingKey: null,
    composerName: null,
    aliases: [],
    source: 'search',
    ...overrides,
  };
}

test('reads catalogue numbers, set members and keys from titles', () => {
  assert.deepEqual(
    [...(numberRefs('24 Caprices, op. 1: No. 5 in A minor').get('no') ?? [])],
    ['5'],
  );
  assert.deepEqual([...(numberRefs('Suite V in D minor: II. Allemande').get('no') ?? [])], ['5']);
  assert.deepEqual([...(numberRefs('Capriccio, Op. 1/24').get('op') ?? [])], ['1']);
  assert.deepEqual([...(numberRefs('Capriccio, Op. 1/24').get('no') ?? [])], ['24']);
  assert.deepEqual(
    [...(numberRefs('Suite in G Major, RCT 6: VI. Les Sauvages').get('rct') ?? [])],
    ['6'],
  );
  assert.equal(movementNumber('Suite V in D minor: II. Allemande'), 2);
  assert.equal(movementNumber('Suite VII in G major: Ciacona'), null);
  assert.equal(keyOf('Suite IV in Bb major'), 'b flat major');
  assert.equal(keyOf('Sonate in B-flat major'), 'b flat major');
  assert.equal(keyOf('Sonate in b-moll'), 'b minor');
  assert.equal(keyOf('Allemande'), null);
});

test('a part of the work other tracks perform, in its album slot, is high confidence', () => {
  const siblings = [
    { medium: 1, position: 1, parentMbid: 'sonata', orderingKey: 1 },
    { medium: 1, position: 2, parentMbid: 'sonata', orderingKey: 2 },
  ];
  const proposal = proposeWork(
    target({ title: 'Piano Sonata No. 14: III. Presto agitato', position: 3, siblings }),
    [
      candidate({
        workMbid: 'mvt-3',
        title: 'Presto agitato',
        parentMbid: 'sonata',
        parentTitle: 'Piano Sonata No. 14 in C-sharp minor, op. 27 no. 2',
        orderingKey: 3,
        source: 'album',
      }),
      candidate({
        workMbid: 'mvt-2',
        title: 'Allegretto',
        parentMbid: 'sonata',
        parentTitle: 'Piano Sonata No. 14 in C-sharp minor, op. 27 no. 2',
        orderingKey: 2,
        source: 'album',
      }),
    ],
  );
  assert.equal(proposal?.workMbid, 'mvt-3');
  assert.equal(proposal?.confidence, 'high');
  assert.ok(proposal?.reasons.some((reason) => reason.includes('2 other tracks')));
});

test('a part that would sit outside the album order is ruled out', () => {
  // Suite III fills tracks 9-16, so track 2 cannot be Suite III's Allemande however well the title
  // matches.
  const siblings = Array.from({ length: 8 }, (_, index) => ({
    medium: 1,
    position: 9 + index,
    parentMbid: 'suite-3',
    orderingKey: 1 + index,
  }));
  const proposal = proposeWork(
    target({ title: 'Suite V in D minor: II. Allemande', position: 2, siblings }),
    [
      candidate({
        workMbid: 'suite-3-allemande',
        title: 'Allemande',
        parentMbid: 'suite-3',
        parentTitle: 'Suite Nr. 3',
        orderingKey: 2,
        source: 'album',
      }),
    ],
  );
  assert.equal(proposal, null);
});

test('titles that disagree on a stated number or key are ruled out', () => {
  const caprice = target({ title: 'No. 3 in E minor: Sostenuto', artistNames: ['Paganini'] });
  assert.equal(
    proposeWork(caprice, [
      candidate({
        title: '24 Caprices, op. 1: No. 4 in C minor: Maestoso',
        composerName: 'Niccolò Paganini',
      }),
    ]),
    null,
  );
  assert.equal(
    proposeWork(target({ title: 'Suite V in D minor: II. Allemande' }), [
      candidate({ title: 'Keyboard Suite in A major: II. Allemande' }),
    ]),
    null,
  );
});

test('a search hit with matching numbers, title and composer is high confidence', () => {
  const proposal = proposeWork(
    target({
      title: 'No. 1 in E major: Andante',
      artistNames: ['Niccolò Paganini', 'Some Violinist'],
    }),
    [
      candidate({
        workMbid: 'caprice-1',
        title: '24 Caprices for Solo Violin, op. 1, MS 25: No. 1 in E major: Andante',
        aliases: ['24 Caprices, Op. 1: No. 1 in E major'],
        composerName: 'Niccolò Paganini',
      }),
    ],
  );
  assert.equal(proposal?.workMbid, 'caprice-1');
  assert.equal(proposal?.confidence, 'high');
  assert.ok(proposal?.reasons.some((reason) => reason.includes('no. 1')));
});

test('an opera number is high confidence when both titles quote its opening words', () => {
  const duet = candidate({
    workMbid: 'duet',
    title:
      'Giulio Cesare in Egitto, HWV 17: Atto I, Scena XI, 16. Duetto “Son nata a lagrimar (Son nato a sospirar)” (Cornelia e Sesto)',
    composerName: 'George Frideric Handel',
  });
  const track = target({
    title:
      'Giulio Cesare in Egitto, HWV 17, Act 1: Duetto. "Son nata a lagrimar" (Cornelia, Sesto)',
    artistNames: ['Handel', 'Emmanuelle Haïm'],
  });
  const proposal = proposeWork(track, [duet]);
  assert.equal(proposal?.confidence, 'high');
  assert.ok(proposal?.reasons.includes('Both titles quote “Son nata a lagrimar”.'));
  // Without the composer the quote alone proposes nothing.
  assert.equal(proposeWork({ ...track, artistNames: ['Emmanuelle Haïm'] }, [duet]), null);
});

test('a near tie is downgraded and says which other work fits', () => {
  const proposal = proposeWork(
    target({ title: 'Prelude No. 3', artistNames: ['Gottlieb Muffat'] }),
    [
      candidate({ workMbid: 'a', title: 'Prelude No. 3', composerName: 'Gottlieb Muffat' }),
      candidate({ workMbid: 'b', title: 'Prelude No. 3', composerName: 'Gottlieb Muffat' }),
    ],
  );
  assert.equal(proposal?.confidence, 'medium');
  assert.ok(proposal?.reasons.some((reason) => reason.includes('fits about as well')));
});

test('nothing is proposed when no candidate clears the bar', () => {
  assert.equal(proposeWork(target({ title: 'Hedwig’s Theme' }), []), null);
  assert.equal(
    proposeWork(target({ title: 'Hedwig’s Theme' }), [candidate({ title: 'Symphony No. 5' })]),
    null,
  );
});

test('one work proposed for two tracks of an album keeps only the better at its confidence', () => {
  const make = (recordingMbid: string, title: string) => ({
    recordingMbid,
    title,
    proposal: proposeWork(target({ title, artistNames: ['Muffat'] }), [
      candidate({ workMbid: 'w', title: 'Suite No. 3: Air', composerName: 'Gottlieb Muffat' }),
    ]),
  });
  const rows = [make('r1', 'Suite III: Air'), make('r2', 'Air')];
  flagSharedProposals(rows);
  assert.notEqual(rows[0].proposal?.confidence, 'low');
  assert.equal(rows[1].proposal?.confidence, 'low');
  assert.ok(rows[1].proposal?.reasons.some((reason) => reason.includes('also proposed')));
});

test('the Inbox view keeps unchecked and unanswered gaps visible and skips recorded ones', () => {
  const gap = (recordingMbid: string, position: number) => ({
    recordingMbid,
    title: `Track ${position}`,
    albumId: 'album-1',
    albumTitle: 'Album',
    releaseMbid: 'release-1',
    medium: 1,
    position,
  });
  const proposal = proposeWork(target({ title: 'No. 1 in E major', artistNames: ['Paganini'] }), [
    candidate({ title: '24 Caprices, op. 1: No. 1 in E major', composerName: 'Niccolò Paganini' }),
  ]);
  assert.ok(proposal);
  const { albums, counts } = proposalAlbums(
    [gap('r3', 3), gap('r1', 1), gap('r2', 2), gap('r4', 4)],
    [
      { recordingMbid: 'r1', proposal, status: 'proposed' },
      { recordingMbid: 'r2', proposal: null, status: 'proposed' },
      { recordingMbid: 'r4', proposal, status: 'approved' },
    ],
    new Set(['r3']),
  );
  assert.deepEqual(
    albums[0].rows.map((row) => [row.recordingMbid, row.state]),
    [
      ['r1', 'proposed'],
      ['r2', 'none'],
      ['r4', 'approved'],
    ],
  );
  assert.equal(counts[proposal.confidence], 1);
  assert.equal(counts.none, 1);
  assert.equal(counts.approved, 1);
  assert.equal(counts.unchecked, 0);
});

test('a movement is never proposed the whole work, nor a differently numbered member', () => {
  const concerto = target({
    title: 'Harpsichord Concerto No. 1 in D Minor, BWV 1052: III. Allegro',
    artistNames: ['Johann Sebastian Bach'],
  });
  assert.equal(
    proposeWork(concerto, [
      candidate({
        title: 'Keyboard Concerto in D minor, BWV 1052',
        composerName: 'Johann Sebastian Bach',
      }),
    ]),
    null,
  );
  const polka = target({
    title: 'Trois Polkas poetiques, Op.8: I. Polka in G minor',
    artistNames: ['Bedřich Smetana'],
  });
  assert.equal(
    proposeWork(polka, [
      candidate({
        title: '3 polkas poétiques, op. 8: No. 2 in G minor',
        composerName: 'Bedřich Smetana',
      }),
    ]),
    null,
  );
});

test('a one-word overlap between short titles is not a proposal', () => {
  assert.equal(
    proposeWork(target({ title: 'The Red Book', artistNames: ['Hans Zimmer'] }), [
      candidate({ title: 'Red Sea', composerName: 'Hans Zimmer' }),
    ]),
    null,
  );
});
