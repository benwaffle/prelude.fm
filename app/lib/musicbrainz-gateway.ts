/**
 * The one place that spends MusicBrainz request budget.
 *
 * MusicBrainz asks anonymous clients for at most one request per second. That
 * is a condition of use, not a suggestion, and it is a *shared* budget: every
 * import, backfill and submission this service makes competes for the same
 * one request per second. So there is exactly one scheduler, and everything
 * queues behind it.
 *
 * Three things follow from the budget being shared and small.
 *
 * **Priority.** A user waiting for their library to import must not sit behind
 * a backfill sweep that will still be running in an hour. Channels are served
 * strictly in order, so a busy `interactive` queue starves `backfill`, and
 * both starve `bot` — which is the intent. Submissions back to MusicBrainz are
 * never urgent.
 *
 * **A persisted counter.** Serverless instances come and go, so an in-process
 * tally measures one lambda rather than the service. The count lives in the
 * database, which also makes "how close are we to needing a mirror?" a query
 * rather than a guess.
 *
 * **A kill switch.** If we are doing something wrong to somebody else's
 * server, stopping must not require a deploy.
 */
import type { MusicBrainzChannel } from './musicbrainz-budget';
import {
  MUSICBRAINZ_CHANNELS,
  type MusicBrainzBudgetStore,
  type MusicBrainzControl,
} from './musicbrainz-budget';

export type { MusicBrainzChannel };
export { MUSICBRAINZ_CHANNELS };

/**
 * 1,000ms plus a margin. The server measures the interval at its end, where
 * network jitter can make two requests sent 1,000ms apart arrive closer
 * together.
 */
const DEFAULT_MIN_INTERVAL_MS = 1_100;
let minIntervalMs = DEFAULT_MIN_INTERVAL_MS;

/** Channels are served in this order, highest priority first. */
const PRIORITY: readonly MusicBrainzChannel[] = ['interactive', 'backfill', 'bot'];

/**
 * Defaults, overridable per channel from the database so a cap can be widened
 * without a deploy.
 *
 * `bot` is 1,000 because the MusicBrainz bot code of conduct caps a bot at
 * 1,000 edits a day. The read channels are far below the 86,400 the rate limit
 * would allow in a day: they are runaway protection, not a policy, and a sweep
 * that genuinely needs more should have to say so.
 */
const DEFAULT_CAPS: Record<MusicBrainzChannel, number> = {
  interactive: 40_000,
  backfill: 40_000,
  bot: 1_000,
};

/** A ceiling across all channels, so no combination of them can run away. */
const DEFAULT_GLOBAL_CAP = 60_000;

/** How long a pause flag or cap override may be stale. */
const CONTROL_TTL_MS = 5_000;

export class MusicBrainzBudgetError extends Error {
  readonly channel: MusicBrainzChannel;
  readonly reason: 'paused' | 'daily-cap';

  constructor(channel: MusicBrainzChannel, reason: 'paused' | 'daily-cap', detail: string) {
    super(detail);
    this.name = 'MusicBrainzBudgetError';
    this.channel = channel;
    this.reason = reason;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The UTC day a request counts against. */
function budgetDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/* --------------------------------------------------------------- store --- */

let injectedStore: MusicBrainzBudgetStore | null = null;
let storePromise: Promise<MusicBrainzBudgetStore> | null = null;
let storeIsFallback = false;

/** Swap the store, for tests and for a caller that owns its own database. */
export function setMusicBrainzBudgetStore(store: MusicBrainzBudgetStore | null) {
  injectedStore = store;
  storePromise = null;
  storeIsFallback = false;
  controlsCache = null;
}

/**
 * An in-memory store, used only when the database-backed one cannot load.
 *
 * Falling back keeps a missing database from taking MusicBrainz reads down
 * with it, but it does silently weaken the daily caps to per-process ones, so
 * the degradation is reported by `musicbrainzGatewayStatus`.
 */
function createMemoryStore(): MusicBrainzBudgetStore {
  const usage = new Map<string, number>();
  let nextSlotAt = 0;
  return {
    async claimSlot(intervalMs) {
      const now = Date.now();
      const slot = Math.max(now, nextSlotAt);
      nextSlotAt = slot + intervalMs;
      return Math.max(0, slot - now);
    },
    async spend(day, channel) {
      const key = `${day}:${channel}`;
      const next = (usage.get(key) ?? 0) + 1;
      usage.set(key, next);
      return next;
    },
    async refund(day, channel) {
      const key = `${day}:${channel}`;
      usage.set(key, Math.max(0, (usage.get(key) ?? 0) - 1));
    },
    async usage(day) {
      const out: Record<string, number> = {};
      for (const [key, count] of usage) {
        const [keyDay, channel] = key.split(':');
        if (keyDay === day) out[channel] = count;
      }
      return out;
    },
    async controls() {
      return {};
    },
  };
}

async function resolveStore(): Promise<MusicBrainzBudgetStore> {
  if (injectedStore) return injectedStore;
  storePromise ??= import('./musicbrainz-budget-store')
    .then((module) => module.createMusicBrainzBudgetStore())
    .catch((error: unknown) => {
      console.warn(
        '[musicbrainz] budget is not persisted; daily caps are per-process only:',
        error instanceof Error ? error.message : error,
      );
      storeIsFallback = true;
      return createMemoryStore();
    });
  return storePromise;
}

/* ------------------------------------------------------------ controls --- */

type Controls = {
  readAt: number;
  byChannel: Record<string, MusicBrainzControl>;
  usage: Record<string, number>;
  total: number;
};

let controlsCache: Controls | null = null;
let controlsInFlight: Promise<Controls> | null = null;

async function readControls(): Promise<Controls> {
  const fresh = controlsCache && Date.now() - controlsCache.readAt < CONTROL_TTL_MS;
  if (fresh && controlsCache) return controlsCache;

  controlsInFlight ??= (async () => {
    try {
      const store = await resolveStore();
      const [byChannel, usage] = await Promise.all([store.controls(), store.usage(budgetDay())]);
      const total = Object.values(usage).reduce((sum, count) => sum + count, 0);
      controlsCache = { readAt: Date.now(), byChannel, usage, total };
      return controlsCache;
    } finally {
      controlsInFlight = null;
    }
  })();

  return controlsInFlight;
}

function capFor(controls: Controls, channel: MusicBrainzChannel): number {
  const override = controls.byChannel[channel]?.dailyCap;
  return override ?? DEFAULT_CAPS[channel];
}

function globalCap(controls: Controls): number {
  return controls.byChannel.all?.dailyCap ?? DEFAULT_GLOBAL_CAP;
}

function pausedReason(controls: Controls, channel: MusicBrainzChannel): string | null {
  for (const key of ['all', channel]) {
    const control = controls.byChannel[key];
    if (control?.paused) return control.note || `${key} is paused`;
  }
  return null;
}

/* ------------------------------------------------------------ dispatch --- */

type Waiter = {
  channel: MusicBrainzChannel;
  enqueuedAt: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const queues: Record<MusicBrainzChannel, Waiter[]> = {
  interactive: [],
  backfill: [],
  bot: [],
};

let pumping = false;

/**
 * Count one request against the day's budget, or refuse it.
 *
 * The count is incremented first and given back if it turns out to breach the
 * cap, because the increment is what makes concurrent workers agree: reading
 * and then writing would let two of them both see 999.
 */
async function reserve(channel: MusicBrainzChannel): Promise<void> {
  const controls = await readControls();

  const paused = pausedReason(controls, channel);
  if (paused) throw new MusicBrainzBudgetError(channel, 'paused', paused);

  const ceiling = globalCap(controls);
  if (controls.total >= ceiling) {
    throw new MusicBrainzBudgetError(
      channel,
      'daily-cap',
      `all channels have used ${controls.total} of ${ceiling} requests today`,
    );
  }

  const day = budgetDay();
  const store = await resolveStore();
  const used = await store.spend(day, channel);
  const cap = capFor(controls, channel);
  if (used > cap) {
    await store.refund(day, channel);
    throw new MusicBrainzBudgetError(
      channel,
      'daily-cap',
      `${channel} has used its ${cap} requests for ${day}`,
    );
  }

  // Keep the cached total moving between refreshes so the global ceiling still
  // bites inside one TTL window.
  controls.total += 1;
  controls.usage[channel] = used;
}

function takeNext(): Waiter | undefined {
  for (const channel of PRIORITY) {
    const waiter = queues[channel].shift();
    if (waiter) return waiter;
  }
  return undefined;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const waiter = takeNext();
      // No `await` between finding the queues empty and clearing `pumping`, so
      // a request arriving now is guaranteed to start a fresh pump.
      if (!waiter) return;

      try {
        await reserve(waiter.channel);
        // Spacing is claimed from the store, not measured here, so that every
        // process sending to MusicBrainz shares one queue of slots.
        const store = await resolveStore();
        const wait = await store.claimSlot(minIntervalMs);
        if (wait > 0) await sleep(wait);
      } catch (error) {
        waiter.reject(error);
        continue;
      }

      try {
        waiter.resolve(await waiter.run());
      } catch (error) {
        waiter.reject(error);
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * Run `request` when the budget allows it, no sooner than one interval after
 * the previous one.
 *
 * Requests are serialised end to end rather than merely started a second
 * apart, which is the conservative reading of the limit and matches what this
 * client has always done.
 */
export function scheduleMusicBrainzRequest<T>(
  channel: MusicBrainzChannel,
  request: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queues[channel].push({
      channel,
      enqueuedAt: Date.now(),
      run: request as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    void pump();
  });
}

/* -------------------------------------------------------------- status --- */

export type MusicBrainzGatewayStatus = {
  day: string;
  persisted: boolean;
  globalCap: number;
  total: number;
  channels: {
    channel: MusicBrainzChannel;
    used: number;
    cap: number;
    paused: boolean;
    note: string | null;
    queued: number;
  }[];
};

/** What admin shows: how much budget today has left, and what is switched off. */
export async function musicbrainzGatewayStatus(): Promise<MusicBrainzGatewayStatus> {
  controlsCache = null;
  const controls = await readControls();
  return {
    day: budgetDay(),
    persisted: !storeIsFallback,
    globalCap: globalCap(controls),
    total: controls.total,
    channels: MUSICBRAINZ_CHANNELS.map((channel) => ({
      channel,
      used: controls.usage[channel] ?? 0,
      cap: capFor(controls, channel),
      paused: Boolean(pausedReason(controls, channel)),
      note: controls.byChannel[channel]?.note ?? controls.byChannel.all?.note ?? null,
      queued: queues[channel].length,
    })),
  };
}

/** Drop cached pause flags so a change made in admin takes effect at once. */
export function invalidateMusicBrainzControls() {
  controlsCache = null;
}

/**
 * Test seam: forget the interval and any queued work.
 *
 * The interval is adjustable because the ordering rules are what the tests are
 * about, and waiting out a real 1.1 seconds between each of them would buy no
 * extra confidence.
 */
export function resetMusicBrainzGatewayForTests(options: { minIntervalMs?: number } = {}) {
  for (const channel of MUSICBRAINZ_CHANNELS) queues[channel].length = 0;
  controlsCache = null;
  storeIsFallback = false;
  minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
}
