import assert from 'node:assert/strict';
import test from 'node:test';
import {
  judgeContestedIsrc,
  type ContestedCarrier,
  type ContestedClaimant,
} from '../app/lib/contested-isrc-verdict';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';

function claimant(
  recordingMbid: string,
  lengthMs: number | null,
  confirmedOtherIsrcs: string[] = [],
): ContestedClaimant {
  return { recordingMbid, title: null, lengthMs, confirmedOtherIsrcs };
}

function carrier(
  durationMs: number,
  positionalRecordingMbid: string | null,
  positionalLengthMs: number | null = null,
): ContestedCarrier {
  return { spotifyTrackId: 'track', durationMs, positionalRecordingMbid, positionalLengthMs };
}

test('a code that slid one track along: the neighbour with its own code loses it', () => {
  // Chopin prelude 8 (89s) also carries prelude 9's code; prelude 9 has its own.
  const verdict = judgeContestedIsrc(
    [claimant(A, 89_000), claimant(B, 90_160, ['DEF057530509'])],
    [carrier(89_066, A)],
  );
  assert.deepEqual(verdict, {
    kind: 'owner',
    ownerMbid: A,
    basis: 'release-position',
    remove: [B],
    duplicates: [],
    unclear: [],
  });
});

test('the same performance entered twice is a merge, not a removal', () => {
  const verdict = judgeContestedIsrc(
    [claimant(A, 534_674), claimant(B, 534_626)],
    [carrier(534_626, B)],
  );
  assert.equal(verdict.kind, 'owner');
  assert.deepEqual(verdict.kind === 'owner' && verdict.duplicates, [A]);
  assert.deepEqual(verdict.kind === 'owner' && verdict.remove, []);
});

test('a claimant far off the length is a different recording even with no code of its own', () => {
  const verdict = judgeContestedIsrc(
    [claimant(A, 291_113), claimant(B, 238_493)],
    [carrier(291_113, A)],
  );
  assert.deepEqual(verdict.kind === 'owner' && verdict.remove, [B]);
});

test('a position whose length disagrees is not evidence', () => {
  const verdict = judgeContestedIsrc(
    [claimant(A, 200_000), claimant(B, 100_000)],
    [carrier(100_000, A)],
  );
  // Falls back to length: only B runs the carrier's length.
  assert.equal(verdict.kind === 'owner' && verdict.basis, 'length');
  assert.equal(verdict.kind === 'owner' && verdict.ownerMbid, B);
});

test('the release track length stands in when the recording has none', () => {
  const verdict = judgeContestedIsrc(
    [claimant(A, null), claimant(B, 50_000, ['OTHER'])],
    [carrier(120_000, A, 120_500)],
  );
  assert.equal(verdict.kind === 'owner' && verdict.ownerMbid, A);
  assert.equal(verdict.kind === 'owner' && verdict.basis, 'release-position');
});

test('tracks placing the code on different recordings leave it undecided', () => {
  const verdict = judgeContestedIsrc(
    [claimant(A, 100_000), claimant(B, 100_500)],
    [carrier(100_000, A), carrier(100_500, B)],
  );
  assert.equal(verdict.kind, 'undecided');
});

test('length alone has to single out one claimant', () => {
  assert.equal(
    judgeContestedIsrc([claimant(A, 100_000), claimant(B, 101_000)], [carrier(100_500, null)]).kind,
    'undecided',
  );
  assert.equal(
    judgeContestedIsrc([claimant(A, 100_000), claimant(B, 300_000)], [carrier(100_500, null)]).kind,
    'owner',
  );
});

test('a code nobody in the library carries is stray only when every claimant has its own', () => {
  assert.deepEqual(
    judgeContestedIsrc(
      [claimant(A, 1, ['X1']), claimant(B, 2, ['X2']), claimant(C, 3, ['X3'])],
      [],
    ),
    { kind: 'stray' },
  );
  assert.equal(judgeContestedIsrc([claimant(A, 1, ['X1']), claimant(B, 2)], []).kind, 'undecided');
});

test('a claimant a little off the owner, with no code of its own, stays unclear', () => {
  const verdict = judgeContestedIsrc(
    [claimant(A, 100_000), claimant(B, 102_500)],
    [carrier(100_000, A)],
  );
  assert.deepEqual(verdict.kind === 'owner' && verdict.unclear, [B]);
});
