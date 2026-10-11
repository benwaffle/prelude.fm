import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { parseEvidence } from '../app/lib/submission-evidence';
import type { MusicBrainzSource } from '../app/lib/musicbrainz-source';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import { fakeSource } from './helpers/musicbrainz-fixtures';

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let kinds: typeof import('../app/lib/submission-kinds');
let ledger: typeof import('../app/lib/submission-ledger');

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  kinds = await import('../app/lib/submission-kinds');
  ledger = await import('../app/lib/submission-ledger');
});

beforeEach(async () => {
  await resetTestDatabase(db);
});

const RELEASE = '11111111-1111-4111-8111-111111111111';
const OTHER_RELEASE = '33333333-3333-4333-8333-333333333333';
const RECORDING = '22222222-2222-4222-8222-222222222222';
const OTHER_RECORDING = '44444444-4444-4444-8444-444444444444';

/** MusicBrainz that knows nothing, counting what it was asked for. */
function emptySource(asked: string[]): MusicBrainzSource {
  return fakeSource({
    releaseWithRecordings: async (mbid) => {
      asked.push(`release:${mbid}`);
      return null;
    },
    recordingDetail: async (mbid) => {
      asked.push(`recording:${mbid}`);
      return null;
    },
  });
}

async function barcodeRow(
  releaseMbid: string,
  outcome: 'pending' | 'applied' | 'rejected' = 'pending',
) {
  await db.insert(schema.mbSubmission).values({
    kind: 'barcode',
    targetMbid: releaseMbid,
    subject: `album-${releaseMbid}`,
    value: '0724356',
    submittedBy: 'human:ben',
    outcome,
  });
}

test('a barcode lands only when the cache holds a real one, and only pending rows change', async () => {
  await db.insert(schema.mbRelease).values([
    { mbid: RELEASE, title: 'Has one', barcode: '0724356' },
    { mbid: OTHER_RELEASE, title: 'Whitespace', barcode: '   ' },
  ]);
  await barcodeRow(RELEASE);
  await barcodeRow(RELEASE, 'rejected');
  await barcodeRow(OTHER_RELEASE);

  const asked: string[] = [];
  const rows = await ledger.readLedger(undefined);
  const result = await kinds.pullAndApply(emptySource(asked), rows);

  // Two rows share one release: it is fetched once.
  assert.deepEqual(asked.sort(), [`release:${RELEASE}`, `release:${OTHER_RELEASE}`]);
  assert.equal(result.targets, 2);
  assert.equal(result.applied, 1);
  assert.equal(result.landed.size, 2, 'the rejected row on a landed release is landed too');

  const after = await db
    .select({ target: schema.mbSubmission.targetMbid, outcome: schema.mbSubmission.outcome })
    .from(schema.mbSubmission)
    .orderBy(schema.mbSubmission.id);
  assert.deepEqual(
    after.map((row) => `${row.target === RELEASE ? 'real' : 'blank'}:${row.outcome}`),
    ['real:applied', 'real:rejected', 'blank:pending'],
  );
});

test('a contested-ISRC report lands once MusicBrainz maps the code to one recording', async () => {
  await db.insert(schema.mbRecording).values([
    { mbid: RECORDING, title: 'Symphony 87', detail: 'full' },
    { mbid: OTHER_RECORDING, title: 'Symphony 82', detail: 'full' },
  ]);
  await db.insert(schema.mbRecordingIsrc).values([
    { isrc: 'GBAYE0601498', recordingMbid: RECORDING },
    { isrc: 'GBAYE0601498', recordingMbid: OTHER_RECORDING },
  ]);
  await db.insert(schema.mbSubmission).values({
    kind: 'error',
    targetMbid: RECORDING,
    subject: 'GBAYE0601498',
    value: 'GBAYE0601498',
    evidence: {
      problem: 'contested_isrc',
      disposition: 'reported',
      recordingMbids: [RECORDING, OTHER_RECORDING],
    },
    submittedBy: 'human:ben',
  });

  const asked: string[] = [];
  const still = await kinds.pullAndApply(emptySource(asked), await ledger.readLedger(undefined));
  assert.deepEqual(asked.sort(), [`recording:${RECORDING}`, `recording:${OTHER_RECORDING}`]);
  assert.equal(still.applied, 0, 'still contested, so still pending');

  await db
    .delete(schema.mbRecordingIsrc)
    .where(eq(schema.mbRecordingIsrc.recordingMbid, OTHER_RECORDING));
  const fixed = await kinds.pullAndApply(emptySource([]), await ledger.readLedger(undefined));
  assert.equal(fixed.applied, 1);
});

test('insertSubmissions writes every draft at once and skips one already in hand', async () => {
  const draft = (isrc: string) => ({
    kind: 'isrc' as const,
    targetMbid: RECORDING,
    subject: 'track-1',
    value: isrc,
    evidence: {
      releaseMbid: RELEASE,
      barcode: null,
      medium: 1,
      position: 1,
      durationDeltaMs: 0,
      matchedBy: 'release_position',
    },
  });
  await ledger.insertSubmissions([draft('GBAYE0601498')], { submittedBy: 'human:ben' });
  await ledger.insertSubmissions(
    [draft('GBAYE0601498'), { ...draft('GBAYE0601499'), note: 'its own note' }],
    {
      submittedBy: 'human:ben',
      note: '  shared  ',
      editId: 'https://musicbrainz.org/edit/123',
    },
  );
  const rows = await ledger.readLedger(undefined);
  assert.deepEqual(
    rows.map((row) => [row.value, row.note, row.editId]),
    [
      ['GBAYE0601498', null, null],
      ['GBAYE0601499', 'its own note', '123'],
    ],
  );
  assert.deepEqual(rows[1].evidence, { kind: 'isrc', releaseMbid: RELEASE });
});

test('evidence is read once, and a field a row lacks reads as missing', () => {
  assert.deepEqual(parseEvidence('release', null), { kind: 'release', releaseMbid: null });
  assert.deepEqual(parseEvidence('work', { recordingMbid: 7 }), {
    kind: 'work',
    recordingMbid: null,
  });
  assert.deepEqual(parseEvidence('error', { problem: 'something new', disposition: 'fixed' }), {
    kind: 'error',
    problem: null,
    disposition: 'fixed',
  });
  assert.deepEqual(
    parseEvidence('error', {
      problem: 'misaligned_tracklist',
      disposition: 'reported',
      releaseMbid: RELEASE,
    }),
    {
      kind: 'error',
      problem: 'misaligned_tracklist',
      disposition: 'reported',
      releaseMbid: RELEASE,
    },
  );
});
