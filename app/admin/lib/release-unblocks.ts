import { loadTracksBlockedOnRelease } from './catalogue-readiness-load';

/**
 * The funnel's per-album counts are the whole library read through the
 * player's projection, which is too slow to redo for every Inbox reload.
 * Held for a minute, and dropped whenever a release lands.
 */
const UNBLOCK_TTL_MS = 60_000;
let unblockCache: { at: number; counts: Promise<Map<string, number> | null> } | null = null;

/** Library tracks each missing album would unblock; null if they could not be counted. */
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

/** A release landed, so the counts are stale. */
export function forgetTracksBlockedOnRelease(): void {
  unblockCache = null;
}
