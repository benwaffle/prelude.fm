'use client';

import { useCallback, useEffect, useState, type DependencyList } from 'react';

/** A failed read is its own state, so a screen can't mistake it for an empty answer. */
export type ServerQuery<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; retry: () => void }
  | {
      status: 'ready';
      data: T;
      // The current data stays on screen until the new data lands; rejects, keeping it, when the
      // read fails.
      refresh: () => Promise<void>;
    };

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Settled<T> {
  deps: DependencyList;
  attempt: number;
  outcome: { ok: true; data: T } | { ok: false; message: string };
}

function sameDeps(left: DependencyList, right: DependencyList): boolean {
  return left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
}

// An answer is only shown for the deps it was asked for, so one composer's works never sit under
// another's name. `load` is null while there is nothing to ask yet.
export function useServerQuery<T>(
  load: (() => Promise<T>) | null,
  deps: DependencyList,
): ServerQuery<T> {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);

  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    load().then(
      (data) => {
        if (!cancelled) setSettled({ deps, attempt, outcome: { ok: true, data } });
      },
      (error: unknown) => {
        console.error('Server read failed:', error);
        if (!cancelled) {
          setSettled({ deps, attempt, outcome: { ok: false, message: failureMessage(error) } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // `deps` stands in for `load`, which is a new closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // Lands only if the deps it was asked under are still the ones shown.
  const refresh = async () => {
    if (!load) return;
    const data = await load();
    setSettled((previous) =>
      previous && previous.attempt === attempt && sameDeps(previous.deps, deps)
        ? { ...previous, outcome: { ok: true, data } }
        : previous,
    );
  };

  if (!load || !settled || settled.attempt !== attempt || !sameDeps(settled.deps, deps)) {
    return { status: 'loading' };
  }
  return settled.outcome.ok
    ? { status: 'ready', data: settled.outcome.data, refresh }
    : { status: 'error', message: settled.outcome.message, retry };
}
