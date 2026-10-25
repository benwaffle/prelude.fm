import assert from 'node:assert/strict';
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
