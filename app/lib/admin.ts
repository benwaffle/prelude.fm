import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { account } from './db/schema';

// The immutable Spotify account id, not the display name: anyone can rename themselves 'benwaffle'.
const ADMIN_SPOTIFY_ID = 'benwaffle';

/** Server only. */
export async function isAdminUser(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ accountId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, 'spotify'),
        eq(account.accountId, ADMIN_SPOTIFY_ID),
      ),
    )
    .limit(1);
  return row !== undefined;
}
