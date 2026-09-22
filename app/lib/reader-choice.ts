'use client';

import { useSyncExternalStore } from 'react';

/**
 * Which reader the library is drawn from.
 *
 * The switch is a rollback control, so it has to work without a deployment:
 * `?reader=musicbrainz` or `?reader=legacy` sets it and it sticks, and
 * NEXT_PUBLIC_READER decides for anyone who has never set it. Legacy stays
 * the default until the shadow comparison says the gates are met.
 */
export type ReaderChoice = 'musicbrainz' | 'legacy';

const STORAGE_KEY = 'prelude.reader';

function isChoice(value: string | null | undefined): value is ReaderChoice {
  return value === 'musicbrainz' || value === 'legacy';
}

export function configuredReader(): ReaderChoice {
  const configured = process.env.NEXT_PUBLIC_READER;
  return isChoice(configured) ? configured : 'legacy';
}

/**
 * Reading the query string is a one-off: it is how the choice is *set*, and
 * once stored the URL has said its piece.
 */
let queryApplied = false;

function currentChoice(): ReaderChoice {
  if (typeof window === 'undefined') return configuredReader();
  if (!queryApplied) {
    queryApplied = true;
    const requested = new URLSearchParams(window.location.search).get('reader');
    if (isChoice(requested)) window.localStorage.setItem(STORAGE_KEY, requested);
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isChoice(stored) ? stored : configuredReader();
}

function subscribe(onChange: () => void): () => void {
  // Another tab flipping the switch should flip this one too.
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

export function useReaderChoice(): ReaderChoice {
  return useSyncExternalStore(subscribe, currentChoice, configuredReader);
}
