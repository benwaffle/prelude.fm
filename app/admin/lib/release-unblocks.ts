import { loadTracksBlockedOnRelease } from './catalogue-readiness-load';

// The projection is too slow per Inbox reload; held a minute for the window of albums shown and
// dropped when a release lands.
const UNBLOCK_TTL_MS = 60_000;
let unblockCache: {
  at: number;
  key: string;
  counts: Promise<Map<string, number> | null>;
} | null = null;

export function tracksBlockedOnRelease(
  albumIds: readonly string[],
): Promise<Map<string, number> | null> {
  const key = albumIds.join(',');
  if (!unblockCache || unblockCache.key !== key || Date.now() - unblockCache.at > UNBLOCK_TTL_MS) {
    unblockCache = {
      at: Date.now(),
      key,
      counts: loadTracksBlockedOnRelease(albumIds).catch(() => {
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
