import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import test, { before, beforeEach } from 'node:test';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';

// A pass checks what it just wrote, not the whole cache: the whole cache is millions of rows.

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let invariants: typeof import('@/lib/musicbrainz-invariants');

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  invariants = await import('@/lib/musicbrainz-invariants');
});

beforeEach(async () => {
  await resetTestDatabase(db);
  for (const album of ['album-ok', 'album-broken']) {
    await db.insert(schema.spotifyAlbum).values({
      spotifyId: album,
      title: album,
      mbReleaseId: `${album}-release`,
    });
    await db.insert(schema.spotifyTrack).values({
      spotifyId: `${album}-track`,
      title: 'x',
      trackNumber: 1,
      durationMs: 1,
      spotifyAlbumId: album,
    });
  }
  await db.insert(schema.mbRecording).values({ mbid: 'held', title: 'x' });
  await db.insert(schema.trackRecording).values([
    { spotifyTrackId: 'album-ok-track', recordingMbid: 'held', matchedBy: 'isrc' },
    // Anchored to a recording the cache does not hold.
    { spotifyTrackId: 'album-broken-track', recordingMbid: 'missing', matchedBy: 'isrc' },
  ]);
  await db.insert(schema.mbReleaseTrack).values({
    releaseMbid: 'album-broken-release',
    medium: 1,
    position: 1,
    recordingMbid: 'missing-too',
    title: 'x',
  });
  await db.insert(schema.mbRecordingIsrc).values({ isrc: 'X', recordingMbid: 'missing-too' });
});

function violations(results: { name: string; violations: number }[]) {
  return Object.fromEntries(results.map((result) => [result.name, result.violations]));
}

test('the cheap checks scoped to albums see only those albums', async () => {
  assert.deepEqual(
    violations(await invariants.runMusicBrainzInvariants({ albums: ['album-ok'] })),
    {
      'anchored-recording-is-cached': 0,
      'tracklist-recording-is-cached': 0,
      'isrc-recording-is-cached': 0,
    },
  );

  const broken = await invariants.runMusicBrainzInvariants({ albums: ['album-broken'] });
  assert.deepEqual(violations(broken), {
    'anchored-recording-is-cached': 1,
    'tracklist-recording-is-cached': 1,
    'isrc-recording-is-cached': 1,
  });
  assert.deepEqual(
    broken.find((result) => result.name === 'anchored-recording-is-cached')?.samples,
    [{ id: 'album-broken-track', detail: 'missing' }],
  );

  const whole = violations(await invariants.runMusicBrainzInvariants({ cheapOnly: true }));
  assert.equal(whole['anchored-recording-is-cached'], 1);
  assert.deepEqual(await invariants.runMusicBrainzInvariants({ albums: [] }), []);
});

test('a clean check carries no samples', async () => {
  const [clean] = await invariants.runMusicBrainzInvariants({ albums: ['album-ok'] });
  assert.deepEqual(clean.samples, []);
});

test('the daily sweep reads a slice a day and reports a pass when it ends', async () => {
  const anchored = 'anchored-recording-is-cached';
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));
  // One rowid a day: track_recording has two rows, so its pass takes two days.
  const sweep = (n: number) =>
    invariants.sweepMusicBrainzInvariants({ minRows: 1, passDays: 1_000, now: day(n) });
  const resultOf = async () =>
    (await invariants.latestInvariantResults()).find((result) => result.name === anchored)!;

  await sweep(1);
  // Halfway: the clean anchor is read, the broken one not yet, and no pass has finished.
  assert.deepEqual((await resultOf()).sweep, {
    cursor: 1,
    end: 2,
    violations: 0,
    startedAt: day(1),
  });
  assert.equal((await resultOf()).checkedAt, null);
  const early = invariants.musicBrainzInvariantHealth(await invariants.latestInvariantResults());
  assert.ok(early.neverRun.includes(anchored));

  const second = await sweep(2);
  // The pass ended: its count is the result, and nothing is in progress.
  const finished = await resultOf();
  assert.equal(finished.violations, 1);
  assert.deepEqual(finished.samples, [{ id: 'album-broken-track', detail: 'missing' }]);
  assert.equal(finished.sweep, null);
  assert.deepEqual(finished.checkedAt, day(2));
  assert.ok(invariants.hardViolations(second).some((result) => result.name === anchored));

  // The next pass starts over. Until it ends, the last finished pass stands beside its progress.
  await db
    .update(schema.trackRecording)
    .set({ recordingMbid: 'missing-again' })
    .where(eq(schema.trackRecording.spotifyTrackId, 'album-broken-track'));
  await sweep(3);
  const partial = await resultOf();
  assert.equal(partial.violations, 1);
  assert.deepEqual(partial.sweep, { cursor: 1, end: 2, violations: 0, startedAt: day(3) });
  await sweep(4);
  const next = await resultOf();
  assert.equal(next.violations, 1);
  assert.deepEqual(next.samples, [{ id: 'album-broken-track', detail: 'missing-again' }]);
});

test('a violation the pass under way has found fails health before the pass ends', () => {
  const health = invariants.musicBrainzInvariantHealth(
    invariants.MUSICBRAINZ_INVARIANTS.map((check) => ({
      name: check.name,
      severity: check.severity,
      describes: check.describes,
      violations: 0,
      samples: [],
      checkedAt: new Date(),
      sweepViolations: check.name === 'anchored-recording-is-cached' ? 2 : 0,
    })),
  );
  assert.equal(health.state, 'red');
  assert.deepEqual(health.failing, ['anchored-recording-is-cached']);
});

test('a small table is read whole by one day of the sweep', async () => {
  const results = await invariants.sweepMusicBrainzInvariants();
  assert.equal(results.length, invariants.MUSICBRAINZ_INVARIANTS.length);
  assert.ok(results.every((result) => result.sweep === null));
  assert.deepEqual(
    Object.fromEntries(
      results
        .filter((result) => result.violations > 0)
        .map((result) => [result.name, result.violations]),
    ),
    {
      'anchored-recording-is-cached': 1,
      'tracklist-recording-is-cached': 1,
      'isrc-recording-is-cached': 1,
    },
  );
});
