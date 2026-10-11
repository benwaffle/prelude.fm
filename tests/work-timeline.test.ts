import assert from 'node:assert/strict';
import test from 'node:test';
import { elapsedMs, locate, readout, seams, workTimeline } from '../app/lib/work-timeline';
import { positionAt } from '../app/lib/spotify/progress';
import { catalogHref, parseCatalogUrl } from '../app/components/catalog/catalog-url';
import { fromSdkTrack, sameTrack, trackUris } from '../app/lib/spotify/now-playing-track';

const heard = [
  { trackId: 'a', durationMs: 60_000 },
  { trackId: 'b', durationMs: 30_000 },
  { trackId: 'c', durationMs: 10_000 },
];

test('the timeline places the playing movement within the whole recording', () => {
  const t = workTimeline(heard, 'b');
  assert.equal(t.totalMs, 100_000);
  assert.equal(t.index, 1);
  assert.equal(t.beforeMs, 60_000);
  assert.equal(elapsedMs(t, 5_000), 65_000);
  // A position Spotify reports past the end stops at the end.
  assert.equal(elapsedMs(t, 90_000), 100_000);
  assert.deepEqual(seams(t), [0.6, 0.9]);
});

test('an unknown track or length is read as the start, and as nothing', () => {
  const t = workTimeline([{ trackId: 'a', durationMs: null }, ...heard.slice(1)], 'zz');
  assert.equal(t.index, 0);
  assert.equal(t.beforeMs, 0);
  assert.equal(t.totalMs, 40_000);
});

test('a point along the bar is a movement and an offset into it', () => {
  const t = workTimeline(heard, 'a');
  assert.deepEqual(locate(t, 0.3), { index: 0, offsetMs: 30_000 });
  assert.deepEqual(locate(t, 0.6), { index: 1, offsetMs: 0 });
  assert.deepEqual(locate(t, 0.95), { index: 2, offsetMs: 5_000 });
  assert.deepEqual(locate(t, 1), { index: 2, offsetMs: 10_000 });
  assert.equal(locate(workTimeline([], null), 0.5), null);
});

test('readouts change only at the precision shown', () => {
  assert.deepEqual(readout(65_000, 100_000), {
    pct: '65.0%',
    elapsed: '1:05',
    remaining: '—0:35',
  });
  assert.deepEqual(readout(65_020, 100_000), readout(65_000, 100_000));
});

test('progress runs on from the last report while playing, and holds while paused', () => {
  const report = { position: 1_000, duration: 5_000, timestamp: 10_000, paused: false };
  assert.equal(positionAt(report, 12_000), 3_000);
  assert.equal(positionAt(report, 20_000), 5_000);
  assert.equal(positionAt({ ...report, paused: true }, 20_000), 1_000);
  assert.equal(positionAt({ ...report, duration: 0 }, 20_000), 11_000);
});

test('the catalogue URL says which pane a phone shows', () => {
  const read = (query: string) => parseCatalogUrl(new URLSearchParams(query));
  assert.deepEqual(read(''), { composerId: null, workId: null, level: 0 });
  assert.deepEqual(read('composer=c1'), { composerId: 'c1', workId: null, level: 1 });
  assert.deepEqual(read('composer=c1&work=w1'), { composerId: 'c1', workId: 'w1', level: 2 });
  assert.equal(catalogHref(null), '/catalog');
  assert.equal(catalogHref('c1', 'w1'), '/catalog?composer=c1&work=w1');
});

test('the browser player track reads its album id off the album URI', () => {
  const track = fromSdkTrack({
    album: { name: 'Album', uri: 'spotify:album:xyz', images: [{ url: 'cover.jpg' }] },
    artists: [],
    duration_ms: 1000,
    id: 't1',
    is_playable: true,
    name: 'Allegro',
    uid: 'u',
    uri: 'spotify:track:t1',
    media_type: 'audio',
    type: 'track',
    track_type: 'audio',
    linked_from: { uri: 'spotify:track:t0', id: 't0' },
  });
  assert.equal(track.albumId, 'xyz');
  assert.equal(track.cover, 'cover.jpg');
  assert.deepEqual(trackUris(track), ['spotify:track:t1', 'spotify:track:t0']);
  assert.ok(sameTrack(track, { ...track }));
  assert.ok(!sameTrack(track, { ...track, id: 't2' }));
});
