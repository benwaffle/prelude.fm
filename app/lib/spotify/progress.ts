/** Where playback was when Spotify last said, and whether it was moving. */
export interface PlaybackProgress {
  position: number;
  duration: number;
  /** When `position` was true, in Date.now() milliseconds. */
  timestamp: number;
  paused: boolean;
}

export const NO_PROGRESS: PlaybackProgress = {
  position: 0,
  duration: 0,
  timestamp: 0,
  paused: true,
};

/** Where playback is now, counting the time since Spotify last reported it. */
export function positionAt(p: PlaybackProgress, now: number): number {
  if (p.paused) return p.position;
  const elapsed = now - p.timestamp;
  return p.duration > 0 ? Math.min(p.position + elapsed, p.duration) : p.position + elapsed;
}

export interface ProgressStore {
  /** The last report, as reported. */
  get(): PlaybackProgress;
  /** Record a new report and tell every subscriber. */
  set(next: PlaybackProgress): void;
  subscribe(callback: (progress: PlaybackProgress) => void): () => void;
}

/**
 * Progress changes many times a second while playing, so it lives outside
 * React state: readouts draw it themselves, and subscribers hear of every
 * report — from the browser's player, a Connect poll, or a tap that moved it.
 */
export function createProgressStore(): ProgressStore {
  let current = NO_PROGRESS;
  const subscribers = new Set<(progress: PlaybackProgress) => void>();
  return {
    get: () => current,
    set(next) {
      current = next;
      subscribers.forEach((callback) => callback(next));
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
  };
}
