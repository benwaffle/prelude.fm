'use client';

import { useCallback, useEffect, useState, type DependencyList } from 'react';

/**
 * One read from the server, as a screen renders it. A failed read is its own
 * state, so a screen can't mistake it for an empty answer.
 */
export type ServerQuery<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; retry: () => void }
  | {
      status: 'ready';
      data: T;
      /**
       * Read again in place: the current data stays on screen until the new
       * data lands. Rejects, keeping the old data, when the read fails.
       */
      refresh: () => Promise<void>;
    };

/** What a thrown value says, in words. */
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

/**
 * Run `load` whenever `deps` change, and say where it got to. An answer is
 * only shown for the deps it was asked for: the moment they change the query
 * reads as loading again, so one composer's works never sit under another's
 * name.
 *
 * `load` is null while there is nothing to ask yet (no composer chosen, a
 * panel closed); the query reads as loading until there is.
 */
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
