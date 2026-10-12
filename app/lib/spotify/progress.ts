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

export function positionAt(p: PlaybackProgress, now: number): number {
  if (p.paused) return p.position;
  const elapsed = now - p.timestamp;
  return p.duration > 0 ? Math.min(p.position + elapsed, p.duration) : p.position + elapsed;
}

export interface ProgressStore {
  get(): PlaybackProgress;
  set(next: PlaybackProgress): void;
  subscribe(callback: (progress: PlaybackProgress) => void): () => void;
}

// Lives outside React state: progress changes many times a second, so readouts draw it themselves.
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
