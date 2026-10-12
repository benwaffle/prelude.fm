/** Split from the scheduler and the database so the scheduler is testable without one. */

export const MUSICBRAINZ_CHANNELS = ['interactive', 'backfill', 'bot'] as const;

// `interactive`: somebody is waiting. `backfill`: filling the shared cache. `bot`: submissions,
// capped separately by the bot code of conduct's 1,000 edits a day.
export type MusicBrainzChannel = (typeof MUSICBRAINZ_CHANNELS)[number];

export function isMusicBrainzChannel(value: string): value is MusicBrainzChannel {
  return (MUSICBRAINZ_CHANNELS as readonly string[]).includes(value);
}

export type MusicBrainzControl = {
  paused: boolean;
  dailyCap: number | null;
  note: string | null;
};

export interface MusicBrainzBudgetStore {
  /** Claiming rather than checking is what makes this work across processes. */
  claimSlot(intervalMs: number): Promise<number>;

  // Incrementing and reading together lets two workers agree on whether the cap has been reached.
  spend(day: string, channel: MusicBrainzChannel): Promise<number>;

  refund(day: string, channel: MusicBrainzChannel): Promise<void>;

  usage(day: string): Promise<Record<string, number>>;

  controls(): Promise<Record<string, MusicBrainzControl>>;
}
