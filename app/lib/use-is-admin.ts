'use client';

import { useEffect, useState } from 'react';
import { getViewerIsAdmin } from '@/app/actions/viewer';

/**
 * Whether the signed-in user is the admin, as the server decides it.
 *
 * Null until the server answers. The rule lives in `lib/admin.ts` only; the
 * client never re-derives it from the session.
 */
export function useIsAdmin(userId: string | null | undefined): boolean | null {
  const [answer, setAnswer] = useState<{ userId: string; isAdmin: boolean } | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    getViewerIsAdmin()
      .then((isAdmin) => {
        if (!cancelled) setAnswer({ userId, isAdmin });
      })
      .catch((error: unknown) => {
        console.error('Failed to check admin access:', error);
        if (!cancelled) setAnswer({ userId, isAdmin: false });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId) return false;
  return answer?.userId === userId ? answer.isAdmin : null;
}
