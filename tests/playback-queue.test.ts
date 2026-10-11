import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_QUEUE,
  handedUris,
  queueReducer,
  restOfCurrent,
  type QueueAction,
  type QueueState,
} from '../app/lib/spotify/playback-queue';
import type { QueueEntry } from '../app/lib/prelude';

const entry = (id: string, uris: string[]): QueueEntry => ({
  id,
  uris,
  title: id,
  subtitle: null,
  cover: null,
});

const run = (actions: QueueAction[], from: QueueState = EMPTY_QUEUE) =>
  actions.reduce(queueReducer, from);

test('handing over a recording puts the whole queue after it', () => {
  const state = run([
    { type: 'add', entry: entry('q1', ['b1', 'b2']) },
    { type: 'add', entry: entry('q2', ['c1']) },
    { type: 'changed' },
    { type: 'handedOver', start: { entryId: null, uris: ['a1', 'a2'] } },
  ]);
  assert.deepEqual(handedUris(state), ['a1', 'a2', 'b1', 'b2', 'c1']);
  assert.equal(state.segmentIndex, 0);
  assert.equal(state.dirty, false);
  assert.deepEqual(
    state.queue.map((e) => e.id),
    ['q1', 'q2'],
  );
});

test('a queued recording leaves the queue when it starts, with any skipped before it', () => {
  const handed = run([
    { type: 'add', entry: entry('q1', ['b1']) },
    { type: 'add', entry: entry('q2', ['c1']) },
    { type: 'add', entry: entry('q3', ['d1']) },
    { type: 'handedOver', start: { entryId: null, uris: ['a1'] } },
  ]);
  const onFirst = queueReducer(handed, { type: 'trackStarted', uris: ['a1'] });
  assert.equal(onFirst, handed, 'the starting recording changes nothing');

  const skipped = queueReducer(handed, { type: 'trackStarted', uris: ['c1'] });
  assert.equal(skipped.segmentIndex, 2);
  assert.deepEqual(
    skipped.queue.map((e) => e.id),
    ['q3'],
  );
});

test('a relinked copy of a queued track still counts as it starting', () => {
  const handed = run([
    { type: 'add', entry: entry('q1', ['b1']) },
    { type: 'handedOver', start: { entryId: null, uris: ['a1'] } },
  ]);
  const started = queueReducer(handed, { type: 'trackStarted', uris: ['b1-relinked', 'b1'] });
  assert.deepEqual(started.queue, []);
});

test('a track we never handed over leaves the queue alone', () => {
  const handed = run([
    { type: 'add', entry: entry('q1', ['b1']) },
    { type: 'handedOver', start: { entryId: null, uris: ['a1'] } },
  ]);
  assert.equal(queueReducer(handed, { type: 'trackStarted', uris: ['zz'] }), handed);
  assert.equal(queueReducer(handed, { type: 'trackStarted', uris: [] }), handed);
});

test('playing the queue takes its first recording off it', () => {
  const state = run([
    { type: 'add', entry: entry('q1', ['b1']) },
    { type: 'add', entry: entry('q2', ['c1']) },
    { type: 'takeFirst' },
    { type: 'handedOver', start: { entryId: null, uris: ['b1'] } },
  ]);
  assert.deepEqual(handedUris(state), ['b1', 'c1']);
  assert.deepEqual(
    state.queue.map((e) => e.id),
    ['q2'],
  );
});

test('clearing or taking from an empty queue is no change at all', () => {
  assert.equal(queueReducer(EMPTY_QUEUE, { type: 'clear' }), EMPTY_QUEUE);
  assert.equal(queueReducer(EMPTY_QUEUE, { type: 'takeFirst' }), EMPTY_QUEUE);
});

test('removing an entry and marking the queue changed', () => {
  const state = run([
    { type: 'add', entry: entry('q1', ['b1']) },
    { type: 'add', entry: entry('q2', ['c1']) },
    { type: 'remove', id: 'q1' },
    { type: 'changed' },
  ]);
  assert.deepEqual(
    state.queue.map((e) => e.id),
    ['q2'],
  );
  assert.equal(state.dirty, true);
  assert.equal(queueReducer(state, { type: 'changed' }), state);
});

test('the rest of the current recording runs from the playing track', () => {
  const state = run([{ type: 'handedOver', start: { entryId: null, uris: ['a1', 'a2', 'a3'] } }]);
  assert.deepEqual(restOfCurrent(state, { uris: ['a2'], uri: 'a2' }), ['a2', 'a3']);
  // Something started elsewhere (the Spotify app): keep just that track.
  assert.deepEqual(restOfCurrent(state, { uris: ['x'], uri: 'x' }), ['x']);
  assert.deepEqual(restOfCurrent(EMPTY_QUEUE, { uris: ['x'], uri: 'x' }), ['x']);
});
