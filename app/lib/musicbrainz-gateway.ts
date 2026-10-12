// MusicBrainz's one-request-per-second limit is a shared budget, so this is the only scheduler.
// Channels are served strictly in priority order; the counter lives in the DB because lambdas come
// and go; the kill switch must not need a deploy.
import type { MusicBrainzChannel } from './musicbrainz-budget';
import {
  MUSICBRAINZ_CHANNELS,
  type MusicBrainzBudgetStore,
  type MusicBrainzControl,
} from './musicbrainz-budget';

export type { MusicBrainzChannel };
export { MUSICBRAINZ_CHANNELS };

/**
 * 1,000ms plus a margin: network jitter can make requests sent 1,000ms apart arrive closer
 * together.
 */
const DEFAULT_MIN_INTERVAL_MS = 1_100;
let minIntervalMs = DEFAULT_MIN_INTERVAL_MS;

const PRIORITY: readonly MusicBrainzChannel[] = ['interactive', 'backfill', 'bot'];

// Overridable from the database without a deploy. `bot` matches the bot code of conduct's 1,000
// edits a day; the read caps are runaway protection, not policy.
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

function budgetDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

let injectedStore: MusicBrainzBudgetStore | null = null;
let storePromise: Promise<MusicBrainzBudgetStore> | null = null;
let storeIsFallback = false;

export function setMusicBrainzBudgetStore(store: MusicBrainzBudgetStore | null) {
  injectedStore = store;
  storePromise = null;
  storeIsFallback = false;
  controlsCache = null;
}

// Only when the DB store cannot load; it weakens daily caps to per-process ones, which
// `musicbrainzGatewayStatus` reports.
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

/** Incremented first and given back on breach, so concurrent workers can't both see 999. */
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

  // Keep the cached total moving between refreshes so the global ceiling still bites inside one TTL
  // window.
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
      // No `await` between finding the queues empty and clearing `pumping`, so a new request starts
      // a fresh pump.
      if (!waiter) return;

      try {
        await reserve(waiter.channel);
        // Spacing is claimed from the store, so every process shares one queue of slots.
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

// Serialised end to end, not merely started a second apart: the conservative reading of the limit.
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

export function resetMusicBrainzGatewayForTests(options: { minIntervalMs?: number } = {}) {
  for (const channel of MUSICBRAINZ_CHANNELS) queues[channel].length = 0;
  controlsCache = null;
  storeIsFallback = false;
  minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
}
