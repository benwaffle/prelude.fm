import type { SQL } from 'drizzle-orm';
import { musicBrainzApi } from '@/lib/musicbrainz';
import { pullAndApply, type PullAndApplyResult } from '@/lib/submission-kinds';
import { readLedger } from '@/lib/submission-ledger';
import { forgetTracksBlockedOnRelease } from './release-unblocks';

/** Not a server action: callers check auth and decide what `where` is. */
export async function recheckLedgerRows(
  where: SQL | undefined,
): Promise<(PullAndApplyResult & { checked: number }) | null> {
  const rows = await readLedger(where);
  if (rows.length === 0) return null;
  const result = await pullAndApply(musicBrainzApi('interactive'), rows);
  // A landed release moves albums out of the missing list and changes its counts.
  if (rows.some((row) => row.kind === 'release' && result.landed.has(row.id))) {
    forgetTracksBlockedOnRelease();
  }
  return { ...result, checked: rows.length };
}
