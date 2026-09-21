/**
 * What the MusicBrainz gateway needs to remember between requests.
 *
 * Split from both the scheduler and the database so that the scheduler can be
 * tested without a database and a caller can supply its own store.
 */

export const MUSICBRAINZ_CHANNELS = ['interactive', 'backfill', 'bot'] as const;

/**
 * Why a request is being made, which is also its priority.
 *
 * - `interactive`: somebody is waiting for the answer — a library import, an
 *   admin lookup.
 * - `backfill`: filling gaps in the shared cache, for nobody in particular.
 * - `bot`: submissions back to MusicBrainz. Lowest, and capped separately,
 *   because the bot code of conduct caps a bot at 1,000 edits a day.
 */
export type MusicBrainzChannel = (typeof MUSICBRAINZ_CHANNELS)[number];

export function isMusicBrainzChannel(value: string): value is MusicBrainzChannel {
  return (MUSICBRAINZ_CHANNELS as readonly string[]).includes(value);
}

/** A pause flag and cap override, keyed by channel or by the pseudo-channel `all`. */
export type MusicBrainzControl = {
  paused: boolean;
  dailyCap: number | null;
  note: string | null;
};

export interface MusicBrainzBudgetStore {
  /**
   * Claim the next moment a request may be sent, and return how long to wait
   * for it in milliseconds.
   *
   * Claiming rather than checking is what makes this work across processes:
   * the caller takes a slot nobody else can have, instead of reading a
   * timestamp that somebody else is about to read too.
   */
  claimSlot(intervalMs: number): Promise<number>;

  /**
   * Count one request against `channel` on `day` and return the channel's new
   * total. Incrementing and reading together is what lets two workers agree on
   * whether the cap has been reached.
   */
  spend(day: string, channel: MusicBrainzChannel): Promise<number>;

  /** Give back a request that was counted but not made. */
  refund(day: string, channel: MusicBrainzChannel): Promise<void>;

  /** Requests spent per channel on `day`. */
  usage(day: string): Promise<Record<string, number>>;

  /** Pause flags and cap overrides, keyed by channel or `all`. */
  controls(): Promise<Record<string, MusicBrainzControl>>;
}
