'use client';

import { useCallback, useState } from 'react';
import { useAdminFailure } from './AdminFailure';

/** Fired after every admin action, so the gateway counter shows what it spent. */
export const ADMIN_ACTION_DONE = 'admin-action-done';

export type AdminActionEffects = {
  clearFailure: () => void;
  showFailure: (error: unknown) => void;
  setPending: (label: string | null) => void;
};

/**
 * One admin action: clear the previous action's failure, show what is in
 * progress, and leave a thrown error in the admin failure notice until the
 * next action or a dismissal. Never rejects, so callers need no try/catch.
 *
 * Only actions report here. Loads and polls show their failures inline where
 * the missing data would be, so a background refresh can never replace or
 * resurrect an action's failure.
 */
export async function runAdminAction(
  label: string,
  action: () => Promise<void>,
  effects: AdminActionEffects,
): Promise<void> {
  effects.clearFailure();
  effects.setPending(label);
  try {
    await action();
  } catch (error) {
    effects.showFailure(error);
  } finally {
    effects.setPending(null);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(ADMIN_ACTION_DONE));
  }
}

/** A component's admin actions: `run` one, with `pending` naming the one in flight. */
export function useAdminAction() {
  const { clearFailure, showFailure } = useAdminFailure();
  const [pending, setPending] = useState<string | null>(null);
  const run = useCallback(
    (label: string, action: () => Promise<void>) =>
      runAdminAction(label, action, { clearFailure, showFailure, setPending }),
    [clearFailure, showFailure],
  );
  return { pending, busy: pending !== null, run };
}
