import { loadTracksBlockedOnRelease } from './catalogue-readiness-load';

// Full-library projection is too slow per Inbox reload; held a minute and dropped when a release
// lands.
const UNBLOCK_TTL_MS = 60_000;
let unblockCache: { at: number; counts: Promise<Map<string, number> | null> } | null = null;

export function tracksBlockedOnRelease(): Promise<Map<string, number> | null> {
  if (!unblockCache || Date.now() - unblockCache.at > UNBLOCK_TTL_MS) {
    unblockCache = {
      at: Date.now(),
      counts: loadTracksBlockedOnRelease().catch(() => {
        unblockCache = null;
        return null;
      }),
    };
  }
  return unblockCache.counts;
}

export function forgetTracksBlockedOnRelease(): void {
  unblockCache = null;
}
