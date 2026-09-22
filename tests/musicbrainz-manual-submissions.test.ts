import assert from 'node:assert/strict';
import test from 'node:test';
import {
  barcodeSubmissionDraft,
  describeLedgerState,
  errorReportDraft,
  ManualSubmissionError,
  normalizeEditId,
  normalizeMbid,
  releaseSubmissionDraft,
  requireMbid,
  submissionIdentity,
  workCreationDraft,
  workRelationshipDraft,
  workRelationshipDraftFromGap,
  type ManualSubmissionDraft,
} from '../app/lib/musicbrainz-manual-submissions';

const WORK_MBID = '5b2b84a0-1b1f-4b3f-9a0e-2b8d0a4e6c31';
const OTHER_WORK_MBID = '9c1a77d2-3f42-4a0b-8f6e-1d5b9e7c2a04';
const RECORDING_MBID = 'a3f0c1e4-5d6b-4c7a-9e8f-0b1c2d3e4f50';

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

test('an MBID is accepted bare, pasted as a URL, and never guessed at', () => {
  assert.equal(normalizeMbid(` ${WORK_MBID.toUpperCase()} `), WORK_MBID);
  assert.equal(normalizeMbid(`https://musicbrainz.org/work/${WORK_MBID}`), WORK_MBID);
  assert.equal(
    normalizeMbid(`https://musicbrainz.org/recording/${RECORDING_MBID}/edit`),
    RECORDING_MBID,
  );
  assert.equal(normalizeMbid('K. 466'), null);
  assert.equal(normalizeMbid(''), null);
  assert.equal(normalizeMbid('5b2b84a0-1b1f-4b3f-9a0e-2b8d0a4e6c3'), null);
  assert.throws(() => requireMbid('not an id', 'The new work'), ManualSubmissionError);
  assert.equal(requireMbid(WORK_MBID, 'The new work'), WORK_MBID);
});

test('a missing edit ID stays missing and a malformed one is refused', () => {
  assert.equal(normalizeEditId(null), null);
  assert.equal(normalizeEditId('   '), null);
  assert.equal(normalizeEditId(' 114857392 '), '114857392');
  assert.equal(normalizeEditId('https://musicbrainz.org/edit/114857392'), '114857392');
  assert.throws(() => normalizeEditId('applied'), ManualSubmissionError);
});

test('a work relationship dedupes per work so a medley can gain several', () => {
  const base = {
    recordingMbid: RECORDING_MBID,
    recordingTitle: 'Allegro',
    albumId: 'spotify-1',
    albumTitle: 'A Recital',
    workTitle: 'Sonata',
    workType: 'Sonata',
    composerMbid: null,
    composerName: 'Mozart',
    catalogues: [{ system: 'K.', number: '466' }],
    candidateEvidence: ['catalogue_match' as const],
  };
  const first = workRelationshipDraft({ ...base, workMbid: WORK_MBID });
  const second = workRelationshipDraft({ ...base, workMbid: OTHER_WORK_MBID });

  assert.equal(first.kind, 'work_relationship');
  assert.equal(first.targetMbid, RECORDING_MBID);
  assert.equal(first.value, WORK_MBID);
  assert.notEqual(submissionIdentity(first), submissionIdentity(second));
  assert.equal(
    submissionIdentity(first),
    submissionIdentity(workRelationshipDraft({ ...base, workMbid: WORK_MBID })),
  );
});

test('a confirmation re-reads the candidate and refuses a work we did not offer', () => {
  const gap = {
    recordingMbid: RECORDING_MBID,
    recordingTitle: 'Allegro',
    albumId: 'spotify-1',
    albumTitle: 'A Recital',
    candidates: [
      {
        workMbid: WORK_MBID,
        title: 'Piano Concerto No. 20',
        type: 'Concerto' as const,
        composerMbid: null,
        composerName: 'Mozart',
        catalogues: [{ system: 'K.', number: '466' }],
        evidence: ['catalogue_match' as const],
      },
    ],
  };

  const draft = workRelationshipDraftFromGap(gap, `https://musicbrainz.org/work/${WORK_MBID}`);
  assert.equal(draft.value, WORK_MBID);
  assert.equal(draft.evidence.workTitle, 'Piano Concerto No. 20');
  assert.deepEqual(draft.evidence.candidateEvidence, ['catalogue_match']);

  assert.throws(() => workRelationshipDraftFromGap(gap, OTHER_WORK_MBID), ManualSubmissionError);
  assert.throws(
    () => workRelationshipDraftFromGap({ ...gap, candidates: [] }, WORK_MBID),
    ManualSubmissionError,
  );
});

test('ledger state names a missing edit ID rather than inventing one', () => {
  assert.equal(
    describeLedgerState({ outcome: 'pending', editId: null }),
    'pending · edit ID missing',
  );
  assert.equal(
    describeLedgerState({ outcome: 'pending', editId: '114857392' }),
    'pending · edit 114857392',
  );
});

test('a work relationship records what we offered, not that it was proved', () => {
  const draft = workRelationshipDraft({
    recordingMbid: RECORDING_MBID,
    recordingTitle: 'Allegro',
    albumId: 'spotify-1',
    albumTitle: 'A Recital',
    workMbid: WORK_MBID,
    workTitle: 'Sonata',
    workType: null,
    composerMbid: null,
    composerName: null,
    catalogues: [],
    candidateEvidence: ['catalogue_match'],
  });
  assert.deepEqual(draft.evidence.candidateEvidence, ['catalogue_match']);
  assert.equal(draft.evidence.workType, null);
  assert.equal(draft.evidence.composerName, null);
  assert.equal(draft.evidence.workUrl, `https://musicbrainz.org/work/${WORK_MBID}`);
});

test('a created work is identified by its new MBID and keeps the proposal as a proposal', () => {
  const draft = workCreationDraft({
    recordingMbid: RECORDING_MBID,
    recordingTitle: 'Allegro',
    albumId: 'spotify-1',
    albumTitle: 'A Recital',
    workMbid: WORK_MBID,
    proposal: {
      localWorkId: 7,
      title: 'Piano Concerto No. 20',
      type: 'Concerto',
      composerName: 'Mozart',
      composerMbid: null,
      catalogues: [{ system: 'K.', number: '466' }],
      provenance: 'legacy_proposal',
    },
  });
  assert.equal(draft.kind, 'work');
  assert.equal(draft.targetMbid, WORK_MBID);
  assert.equal(draft.value, WORK_MBID);
  assert.equal(
    (draft.evidence.proposal as { provenance: string } | null)?.provenance,
    'legacy_proposal',
  );
});

test('a created work with no local proposal records the absence rather than a placeholder', () => {
  const draft = workCreationDraft({
    recordingMbid: RECORDING_MBID,
    recordingTitle: 'Allegro',
    albumId: 'spotify-1',
    albumTitle: 'A Recital',
    workMbid: WORK_MBID,
    proposal: null,
  });
  assert.equal(draft.evidence.proposal, null);
});

test('a release submitted before its MBID exists is identified by the Spotify album', () => {
  const pending = releaseSubmissionDraft({
    albumId: 'spotify-1',
    albumTitle: 'A Recital',
    year: 1994,
    upc: '00028946813423',
    trackCount: 12,
    reason: 'no release carries this barcode',
    releaseMbid: null,
  });
  assert.equal(pending.targetMbid, null);
  assert.equal(pending.value, 'https://open.spotify.com/album/spotify-1');
  assert.equal(pending.evidence.releaseUrl, null);

  const created = releaseSubmissionDraft({
    albumId: 'spotify-1',
    albumTitle: 'A Recital',
    year: 1994,
    upc: '00028946813423',
    trackCount: 12,
    reason: 'no release carries this barcode',
    releaseMbid: '7c4f2b10-9a8d-4e6f-b1c3-5d7e9f0a2b46',
  });
  assert.equal(created.targetMbid, '7c4f2b10-9a8d-4e6f-b1c3-5d7e9f0a2b46');
  assert.equal(created.value, '7c4f2b10-9a8d-4e6f-b1c3-5d7e9f0a2b46');
});

test('a contested ISRC report keeps every recording and still dedupes', () => {
  const report = {
    kind: 'contested_isrc' as const,
    isrc: 'GBAYE0601498',
    recordingMbids: [OTHER_WORK_MBID, RECORDING_MBID],
    titles: 'Symphony 87 / Symphony 82',
    albumId: 'spotify-1',
  };
  const draft = errorReportDraft(report, 'reported');
  assert.equal(draft.kind, 'error');
  assert.equal(draft.targetMbid, [OTHER_WORK_MBID, RECORDING_MBID].sort()[0]);
  assert.equal(draft.value, 'GBAYE0601498');
  assert.deepEqual(draft.evidence.recordingMbids, [OTHER_WORK_MBID, RECORDING_MBID].sort());
  assert.equal(draft.evidence.disposition, 'reported');

  const reordered = errorReportDraft(
    { ...report, recordingMbids: [RECORDING_MBID, OTHER_WORK_MBID] },
    'reported',
  );
  assert.equal(submissionIdentity(draft), submissionIdentity(reordered));
});

test('a contested ISRC report refuses to name no recordings at all', () => {
  assert.throws(
    () =>
      errorReportDraft(
        {
          kind: 'contested_isrc',
          isrc: 'GBAYE0601498',
          recordingMbids: [],
          titles: '',
          albumId: null,
        },
        'reported',
      ),
    ManualSubmissionError,
  );
});

test('a misaligned tracklist report shows both sides of every disagreement', () => {
  const draft = errorReportDraft(
    {
      kind: 'misaligned_tracklist',
      albumId: 'spotify-1',
      albumTitle: 'A Recital',
      releaseMbid: '7c4f2b10-9a8d-4e6f-b1c3-5d7e9f0a2b46',
      diagnosis: 'reordered',
      ourTrackCount: 21,
      theirTrackCount: 21,
      mismatches: [
        {
          position: 21,
          ourTitle: 'Allegro',
          ourMs: 401_000,
          theirTitle: 'Adagio',
          theirMs: 220_000,
        },
      ],
    },
    'fixed',
  );
  assert.equal(draft.targetMbid, '7c4f2b10-9a8d-4e6f-b1c3-5d7e9f0a2b46');
  assert.equal(draft.value, 'spotify-1');
  assert.equal(draft.evidence.disposition, 'fixed');
  assert.deepEqual(draft.evidence.mismatches, [
    { position: 21, ourTitle: 'Allegro', ourMs: 401_000, theirTitle: 'Adagio', theirMs: 220_000 },
  ]);
});

test('every draft class carries a non-null ledger value', () => {
  const drafts: ManualSubmissionDraft[] = [
    barcodeSubmissionDraft({
      releaseMbid: 'release-1',
      releaseTitle: 'A Release',
      albumId: 'spotify-1',
      barcode: '123',
      trackCount: 1,
      maxDurationDeltaMs: 0,
    }),
    workRelationshipDraft({
      recordingMbid: RECORDING_MBID,
      recordingTitle: 'Allegro',
      albumId: 'spotify-1',
      albumTitle: 'A Recital',
      workMbid: WORK_MBID,
      workTitle: 'Sonata',
      workType: null,
      composerMbid: null,
      composerName: null,
      catalogues: [],
      candidateEvidence: [],
    }),
    workCreationDraft({
      recordingMbid: RECORDING_MBID,
      recordingTitle: 'Allegro',
      albumId: 'spotify-1',
      albumTitle: 'A Recital',
      workMbid: WORK_MBID,
      proposal: null,
    }),
    releaseSubmissionDraft({
      albumId: 'spotify-1',
      albumTitle: 'A Recital',
      year: null,
      upc: null,
      trackCount: 1,
      reason: 'Spotify gives no barcode',
      releaseMbid: null,
    }),
    errorReportDraft(
      {
        kind: 'contested_isrc',
        isrc: 'GBAYE0601498',
        recordingMbids: [RECORDING_MBID],
        titles: 'Symphony 87',
        albumId: null,
      },
      'reported',
    ),
  ];
  for (const draft of drafts) {
    assert.ok(draft.value.length > 0, `${draft.kind} has an empty ledger value`);
  }
});
