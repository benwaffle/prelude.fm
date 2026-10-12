'use client';

import { useEffect, useState } from 'react';
import { getViewerIsAdmin } from '@/app/actions/viewer';

/** Null until the server answers; the rule lives only in `lib/admin.ts`. */
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
