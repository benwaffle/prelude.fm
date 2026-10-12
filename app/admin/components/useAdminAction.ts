'use client';

import { useCallback, useState } from 'react';
import { enqueueAdminAction } from './admin-action-queue';
import { failureMessage } from '@/lib/use-server-query';
import { useAdminFailure } from './AdminFailure';

export const ADMIN_ACTION_DONE = 'admin-action-done';

export type AdminActionStatus = 'queued' | 'running';

export type AdminActionEffects = {
  clearFailure: () => void;
  showFailure: (error: unknown) => void;
  setStatus: (status: AdminActionStatus | null) => void;
};

// Never rejects. `queue: false` runs at once, for controls (like stopping the gateway) that must
// not wait behind queued edits.
export async function runAdminAction(
  action: () => Promise<void>,
  effects: AdminActionEffects,
  { queue = true }: { queue?: boolean } = {},
): Promise<void> {
  effects.clearFailure();
  // Idle before the next queued action starts, so only one row says running.
  const work = async () => {
    try {
      await action();
    } catch (error) {
      effects.showFailure(error);
    } finally {
      effects.setStatus(null);
    }
  };
  if (queue) {
    effects.setStatus('queued');
    await enqueueAdminAction(() => effects.setStatus('running'), work);
  } else {
    effects.setStatus('running');
    await work();
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ADMIN_ACTION_DONE));
}

export type RowAction = {
  label: string;
  status: AdminActionStatus | null;
  failure: string | null;
};

export type RowActionState = RowAction & {
  busy: boolean;
  dismiss: () => void;
};

const IDLE: RowAction = { label: '', status: null, failure: null };

export function pendingSummary(
  section: { label: string; status: AdminActionStatus | null },
  rows: RowAction[],
): string | null {
  const active = [section, ...rows].filter((entry) => entry.status !== null);
  if (active.length === 0) return null;
  const running = active.find((entry) => entry.status === 'running');
  const queued = active.filter((entry) => entry.status === 'queued').length;
  if (!running) return `${queued} queued behind other admin actions`;
  return queued > 0 ? `${running.label} · ${queued} more queued` : running.label;
}

export function useAdminAction({ queue = true }: { queue?: boolean } = {}) {
  const { clearFailure, showFailure } = useAdminFailure();
  const [section, setSection] = useState<{ label: string; status: AdminActionStatus | null }>({
    label: '',
    status: null,
  });
  const [rows, setRows] = useState<Record<string, RowAction>>({});

  const run = useCallback(
    (label: string, action: () => Promise<void>) =>
      runAdminAction(
        action,
        {
          clearFailure,
          showFailure,
          setStatus: (status) => setSection({ label, status }),
        },
        { queue },
      ),
    [clearFailure, showFailure, queue],
  );

  const patchRow = useCallback((key: string, patch: Partial<RowAction>) => {
    setRows((current) => {
      const next = { ...(current[key] ?? IDLE), ...patch };
      const updated = { ...current };
      if (next.status === null && next.failure === null) delete updated[key];
      else updated[key] = next;
      return updated;
    });
  }, []);

  const runRow = useCallback(
    (key: string, label: string, action: () => Promise<void>) =>
      runAdminAction(
        action,
        {
          clearFailure: () => patchRow(key, { failure: null }),
          showFailure: (error) => patchRow(key, { failure: failureMessage(error) }),
          setStatus: (status) => patchRow(key, { label, status }),
        },
        { queue },
      ),
    [patchRow, queue],
  );

  const row = (key: string): RowActionState => {
    const state = rows[key] ?? IDLE;
    return {
      ...state,
      busy: state.status !== null,
      dismiss: () => patchRow(key, { failure: null }),
    };
  };

  return {
    pending: pendingSummary(section, Object.values(rows)),
    busy: section.status !== null,
    run,
    runRow,
    row,
  };
}
