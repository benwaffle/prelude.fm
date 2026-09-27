import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import {
  blocksResubmission,
  describePreviousSubmission,
  needsExplicitResubmission,
  splitSubmissionHistory,
} from '../app/lib/musicbrainz-manual-submissions';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let contributions: typeof import('../app/lib/musicbrainz-contributions');
let bot: typeof import('../app/lib/musicbrainz-bot');

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  contributions = await import('../app/lib/musicbrainz-contributions');
  bot = await import('../app/lib/musicbrainz-bot');
});

beforeEach(async () => {
  await resetTestDatabase(db);
});

const RELEASE = '11111111-1111-4111-8111-111111111111';
const RECORDING = '22222222-2222-4222-8222-222222222222';
const ISRC = 'GBAYE0601498';

/** One album, one track, matched by barcode to a one-track release that lacks the ISRC. */
async function seedIsrcGap() {
  await db.insert(schema.mbRelease).values({ mbid: RELEASE, title: 'Album', barcode: '724356' });
  await db
    .insert(schema.mbRecording)
    .values({ mbid: RECORDING, title: 'Sonata', length: 300_000, detail: 'full' });
  await db.insert(schema.mbReleaseTrack).values({
    releaseMbid: RELEASE,
    medium: 1,
    position: 1,
    recordingMbid: RECORDING,
    title: 'Sonata',
    length: 300_000,
  });
  await db
    .insert(schema.spotifyAlbum)
    .values({ spotifyId: 'album-1', title: 'Album', upc: '0724356', mbReleaseId: RELEASE });
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-1',
    title: 'Sonata',
    trackNumber: 1,
    discNumber: 1,
    durationMs: 300_500,
    spotifyAlbumId: 'album-1',
    isrc: ISRC,
  });
  await db.insert(schema.trackRecording).values({
    spotifyTrackId: 'track-1',
    recordingMbid: RECORDING,
    isrc: ISRC,
    matchedBy: 'release_position',
  });
}

async function submitIsrc(outcome: 'pending' | 'applied' | 'rejected' | 'withdrawn', editId = '7') {
  await db.insert(schema.mbSubmission).values({
    kind: 'isrc',
    targetMbid: RECORDING,
    subject: 'track-1',
    value: ISRC,
    submittedBy: 'bot:prelude_fm_bot',
    editId,
    outcome,
  });
}

test('only pending and applied block offering an edit again', () => {
  assert.equal(blocksResubmission('pending'), true);
  assert.equal(blocksResubmission('applied'), true);
  assert.equal(blocksResubmission('rejected'), false);
  assert.equal(blocksResubmission('withdrawn'), false);
});

test('a rejected edit needs its own click; a withdrawn one counts as fresh', () => {
  assert.equal(needsExplicitResubmission({ outcome: 'rejected' }), true);
  assert.equal(needsExplicitResubmission({ outcome: 'withdrawn' }), false);
  assert.equal(needsExplicitResubmission(null), false);
});

test('history splits into the attempt in hand and the latest earlier one', () => {
  const rows = [
    { id: 1, outcome: 'rejected' },
    { id: 2, outcome: 'withdrawn' },
    { id: 3, outcome: 'pending' },
  ];
  assert.deepEqual(splitSubmissionHistory(rows), {
    current: { id: 3, outcome: 'pending' },
    previous: { id: 2, outcome: 'withdrawn' },
  });
  assert.deepEqual(splitSubmissionHistory([{ id: 4, outcome: 'rejected' }]), {
    current: null,
    previous: { id: 4, outcome: 'rejected' },
  });
});

test('a returned gap says what happened before', () => {
  assert.equal(
    describePreviousSubmission({ outcome: 'rejected', editId: '123' }),
    'rejected before (edit 123)',
  );
  assert.equal(
    describePreviousSubmission({ outcome: 'withdrawn', editId: null }),
    'withdrawn before (edit ID missing)',
  );
});

test('the ledger keeps a rejected row beside a new attempt, but never two in hand', async () => {
  await seedIsrcGap();
  await submitIsrc('rejected', '1');
  await submitIsrc('pending', '2');
  await db
    .insert(schema.mbSubmission)
    .values({
      kind: 'isrc',
      targetMbid: RECORDING,
      subject: 'track-1',
      value: ISRC,
      submittedBy: 'human:ben',
    })
    .onConflictDoNothing();
  const rows = await db
    .select({ outcome: schema.mbSubmission.outcome, editId: schema.mbSubmission.editId })
    .from(schema.mbSubmission)
    .where(eq(schema.mbSubmission.targetMbid, RECORDING));
  assert.deepEqual(
    rows.map((row) => `${row.outcome}:${row.editId}`),
    ['rejected:1', 'pending:2'],
  );
});

test('a pending or applied ISRC is neither eligible nor batched', async () => {
  await seedIsrcGap();
  assert.equal((await contributions.isrcEligibleGaps()).length, 1);
  assert.equal((await contributions.isrcBatchGaps()).length, 1);

  await submitIsrc('pending');
  assert.equal((await contributions.isrcEligibleGaps()).length, 0);
  assert.equal((await contributions.isrcBatchGaps()).length, 0);
  // Still listed, so its status stays visible.
  assert.equal((await contributions.isrcGaps()).length, 1);
});

test('a rejected ISRC is eligible again but stays out of the batch', async () => {
  await seedIsrcGap();
  await submitIsrc('rejected');
  assert.equal((await contributions.isrcEligibleGaps()).length, 1);
  assert.equal((await contributions.isrcBatchGaps()).length, 0);

  const batch = await bot.runIsrcBot({ releaseMbid: RELEASE });
  assert.equal(batch.edits, 0);
  const resubmit = await bot.runIsrcBot({
    releaseMbid: RELEASE,
    resubmit: { recordingMbid: RECORDING, isrc: ISRC.toLowerCase() },
  });
  assert.deepEqual(resubmit.items, [{ recordingMbid: RECORDING, isrc: ISRC }]);
});

test('a withdrawn ISRC goes back into the batch like a fresh one', async () => {
  await seedIsrcGap();
  await submitIsrc('withdrawn');
  assert.equal((await contributions.isrcBatchGaps()).length, 1);
  const run = await bot.runIsrcBot({ releaseMbid: RELEASE });
  assert.equal(run.edits, 1);
});

/** A release with no barcode that Spotify's album matches by title and duration. */
async function seedBarcodeGap() {
  await db.insert(schema.mbRelease).values({ mbid: RELEASE, title: 'Album', barcode: null });
  await db
    .insert(schema.mbRecording)
    .values({ mbid: RECORDING, title: 'Sonata', length: 300_000, detail: 'full' });
  await db.insert(schema.mbReleaseTrack).values({
    releaseMbid: RELEASE,
    medium: 1,
    position: 1,
    recordingMbid: RECORDING,
    title: 'Sonata',
    length: 300_000,
  });
  await db
    .insert(schema.spotifyAlbum)
    .values({ spotifyId: 'album-1', title: 'Album', upc: '0724356', mbReleaseId: RELEASE });
  await db.insert(schema.spotifyTrack).values({
    spotifyId: 'track-1',
    title: 'Sonata',
    trackNumber: 1,
    discNumber: 1,
    durationMs: 300_500,
    spotifyAlbumId: 'album-1',
  });
}

test('a rejected barcode returns, but only its own row resubmits it', async () => {
  await seedBarcodeGap();
  const [gap] = await contributions.barcodeGaps();
  assert.ok(gap, 'fixture should be a barcode gap');
  await db.insert(schema.mbSubmission).values({
    kind: 'barcode',
    targetMbid: RELEASE,
    subject: 'album-1',
    value: gap.barcode,
    submittedBy: 'bot:prelude_fm_bot',
    outcome: 'rejected',
  });

  assert.equal((await contributions.barcodeEligibleGaps()).length, 1);
  assert.equal((await contributions.barcodeEligibleGaps(200, 0, { batch: true })).length, 0);
  assert.equal((await bot.runBarcodeBot({})).edits, 0);
  assert.equal((await bot.runBarcodeBot({ releaseMbid: RELEASE })).edits, 1);
});
