import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MusicBrainzBudgetError,
  invalidateMusicBrainzControls,
  musicbrainzGatewayStatus,
  resetMusicBrainzGatewayForTests,
  scheduleMusicBrainzRequest,
  setMusicBrainzBudgetStore,
} from '../app/lib/musicbrainz-gateway';
import type {
  MusicBrainzBudgetStore,
  MusicBrainzChannel,
  MusicBrainzControl,
} from '../app/lib/musicbrainz-budget';

/** A store that counts in a Map, so the scheduler can be tested without a database. */
function fakeStore(controls: Record<string, Partial<MusicBrainzControl>> = {}) {
  const spent = new Map<string, number>();
  let nextSlotAt = 0;
  const store: MusicBrainzBudgetStore & { spendCalls: number } = {
    spendCalls: 0,
    async claimSlot(intervalMs) {
      const now = Date.now();
      const slot = Math.max(now, nextSlotAt);
      nextSlotAt = slot + intervalMs;
      return Math.max(0, slot - now);
    },
    async spend(day, channel) {
      store.spendCalls++;
      const key = `${day}:${channel}`;
      const next = (spent.get(key) ?? 0) + 1;
      spent.set(key, next);
      return next;
    },
    async refund(day, channel) {
      const key = `${day}:${channel}`;
      spent.set(key, Math.max(0, (spent.get(key) ?? 0) - 1));
    },
    async usage(day) {
      const out: Record<string, number> = {};
      for (const [key, count] of spent) {
        const [keyDay, channel] = key.split(':');
        if (keyDay === day) out[channel] = count;
      }
      return out;
    },
    async controls() {
      const out: Record<string, MusicBrainzControl> = {};
      for (const [channel, control] of Object.entries(controls)) {
        out[channel] = {
          paused: control.paused ?? false,
          dailyCap: control.dailyCap ?? null,
          note: control.note ?? null,
        };
      }
      return out;
    },
  };
  return store;
}

function prepare(controls: Record<string, Partial<MusicBrainzControl>> = {}) {
  const store = fakeStore(controls);
  setMusicBrainzBudgetStore(store);
  resetMusicBrainzGatewayForTests({ minIntervalMs: 20 });
  return store;
}

/** A promise a test can settle by hand, to hold the gateway busy. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('a busy gateway serves interactive before backfill before bot', async () => {
  prepare();
  const order: string[] = [];

  // Occupy the gateway so the three below queue up rather than each being
  // dispatched the moment it arrives.
  const blocker = deferred<void>();
  const held = scheduleMusicBrainzRequest('backfill', async () => {
    order.push('blocker');
    await blocker.promise;
  });

  const queued = [
    scheduleMusicBrainzRequest('bot', async () => void order.push('bot')),
    scheduleMusicBrainzRequest('backfill', async () => void order.push('backfill')),
    scheduleMusicBrainzRequest('interactive', async () => void order.push('interactive')),
  ];

  blocker.resolve();
  await Promise.all([held, ...queued]);

  assert.deepEqual(order, ['blocker', 'interactive', 'backfill', 'bot']);
});

test('requests within one channel keep their arrival order', async () => {
  prepare();
  const order: number[] = [];

  const blocker = deferred<void>();
  const held = scheduleMusicBrainzRequest('backfill', () => blocker.promise);
  const queued = [1, 2, 3, 4].map((n) =>
    scheduleMusicBrainzRequest('backfill', async () => void order.push(n)),
  );

  blocker.resolve();
  await Promise.all([held, ...queued]);

  assert.deepEqual(order, [1, 2, 3, 4]);
});

test('requests are spaced by the interval and never overlap', async () => {
  prepare();
  const starts: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  await Promise.all(
    [1, 2, 3].map(() =>
      scheduleMusicBrainzRequest('backfill', async () => {
        starts.push(Date.now());
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
      }),
    ),
  );

  assert.equal(maxInFlight, 1, 'the one-request-per-second rule requires serialisation');
  for (let i = 1; i < starts.length; i++) {
    // A couple of milliseconds of timer slack; the point is that the wait happened.
    assert.ok(
      starts[i] - starts[i - 1] >= 18,
      `gap ${starts[i] - starts[i - 1]}ms was shorter than the interval`,
    );
  }
});

test('a pause on a channel refuses that channel and leaves the others alone', async () => {
  prepare({ bot: { paused: true, note: 'awaiting bot approval' } });

  await assert.rejects(
    scheduleMusicBrainzRequest('bot', async () => 'sent'),
    (error: unknown) => {
      assert.ok(error instanceof MusicBrainzBudgetError);
      assert.equal(error.reason, 'paused');
      assert.match(error.message, /awaiting bot approval/);
      return true;
    },
  );

  assert.equal(await scheduleMusicBrainzRequest('interactive', async () => 'ok'), 'ok');
});

test('a pause on `all` stops every channel', async () => {
  prepare({ all: { paused: true, note: 'stop' } });

  for (const channel of ['interactive', 'backfill', 'bot'] as MusicBrainzChannel[]) {
    await assert.rejects(
      scheduleMusicBrainzRequest(channel, async () => 'sent'),
      MusicBrainzBudgetError,
    );
  }
});

test('a channel stops at its daily cap and does not bank the refusal', async () => {
  const store = prepare({ bot: { dailyCap: 2 } });

  assert.equal(await scheduleMusicBrainzRequest('bot', async () => 1), 1);
  assert.equal(await scheduleMusicBrainzRequest('bot', async () => 2), 2);
  await assert.rejects(
    scheduleMusicBrainzRequest('bot', async () => 3),
    (error: unknown) => {
      assert.ok(error instanceof MusicBrainzBudgetError);
      assert.equal(error.reason, 'daily-cap');
      return true;
    },
  );

  // The refused attempt was counted and then given back, so the recorded usage
  // is still the two requests that were actually made.
  const status = await musicbrainzGatewayStatus();
  const bot = status.channels.find((c) => c.channel === 'bot');
  assert.equal(bot?.used, 2);
  assert.equal(store.spendCalls, 3);
});

test('the cap on one channel does not spend another budget', async () => {
  prepare({ bot: { dailyCap: 0 } });
  await assert.rejects(
    scheduleMusicBrainzRequest('bot', async () => 'x'),
    MusicBrainzBudgetError,
  );
  assert.equal(await scheduleMusicBrainzRequest('backfill', async () => 'ok'), 'ok');
});

test('a failing request rejects its own caller and the queue keeps moving', async () => {
  prepare();

  const blocker = deferred<void>();
  const held = scheduleMusicBrainzRequest('backfill', () => blocker.promise);
  const boom = scheduleMusicBrainzRequest('backfill', async () => {
    throw new Error('network down');
  });
  const after = scheduleMusicBrainzRequest('backfill', async () => 'still here');

  blocker.resolve();
  await held;
  await assert.rejects(boom, /network down/);
  assert.equal(await after, 'still here');
});

test('status reports usage, caps, pauses and queue depth', async () => {
  prepare({ backfill: { dailyCap: 5 }, bot: { paused: true } });

  await scheduleMusicBrainzRequest('backfill', async () => 'a');
  await scheduleMusicBrainzRequest('interactive', async () => 'b');

  const status = await musicbrainzGatewayStatus();
  assert.equal(status.total, 2);
  assert.equal(status.day, new Date().toISOString().slice(0, 10));

  const byChannel = Object.fromEntries(status.channels.map((c) => [c.channel, c]));
  assert.equal(byChannel.backfill.used, 1);
  assert.equal(byChannel.backfill.cap, 5);
  assert.equal(byChannel.interactive.used, 1);
  assert.equal(byChannel.bot.used, 0);
  assert.equal(byChannel.bot.paused, true);
  for (const channel of status.channels) assert.equal(channel.queued, 0);
});

test('a control change takes effect once the cache is dropped', async () => {
  const controls: Record<string, Partial<MusicBrainzControl>> = {};
  const store = fakeStore(controls);
  setMusicBrainzBudgetStore(store);
  resetMusicBrainzGatewayForTests({ minIntervalMs: 5 });

  assert.equal(await scheduleMusicBrainzRequest('backfill', async () => 'ok'), 'ok');

  controls.all = { paused: true, note: 'stopped by hand' };
  invalidateMusicBrainzControls();

  await assert.rejects(
    scheduleMusicBrainzRequest('backfill', async () => 'ok'),
    /stopped by hand/,
  );
});

test.after(() => setMusicBrainzBudgetStore(null));

test('spacing comes from the store, so every process shares one queue of slots', async () => {
  // The gateway must not measure the interval itself: an in-process timer
  // spaces out one lambda's requests while three others send their own.
  const asked: number[] = [];
  let released = 0;
  setMusicBrainzBudgetStore({
    async claimSlot(intervalMs) {
      asked.push(intervalMs);
      released += 1;
      // The store, not the gateway, decides how long to wait.
      return released === 2 ? 30 : 0;
    },
    async spend() {
      return 1;
    },
    async refund() {},
    async usage() {
      return {};
    },
    async controls() {
      return {};
    },
  });
  resetMusicBrainzGatewayForTests({ minIntervalMs: 77 });

  const started = Date.now();
  await scheduleMusicBrainzRequest('backfill', async () => 'first');
  await scheduleMusicBrainzRequest('backfill', async () => 'second');

  assert.deepEqual(asked, [77, 77], 'the configured interval is what the store is asked for');
  assert.ok(Date.now() - started >= 25, 'the gateway waited the slot the store handed it');
});
