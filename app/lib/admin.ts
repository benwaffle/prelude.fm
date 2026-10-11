import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { account } from './db/schema';

/**
 * Ben's Spotify user id: the immutable id Better Auth stores as the Spotify
 * account's `accountId`.
 *
 * Not the display name. Spotify lets anyone set their display name to
 * anything, so `user.name === 'benwaffle'` let any account that renamed
 * itself into the admin.
 */
const ADMIN_SPOTIFY_ID = 'benwaffle';

/** Whether this signed-in user is the admin. Server only. */
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
