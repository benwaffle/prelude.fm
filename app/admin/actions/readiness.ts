'use server';

import type { ReadinessFunnel } from '@/lib/catalogue-readiness';
import { contributionCounts } from '@/lib/musicbrainz-contributions';
import { loadReadinessFunnel } from '../lib/catalogue-readiness-load';
import { checkAuth } from './auth';

type Loaded<T> = { value: T; error: null } | { value: null; error: string };

function settle<T>(read: Promise<T>): Promise<Loaded<T>> {
  return read.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({
      value: null,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * Everything the admin home reads, in one action.
 *
 * Next runs a page's server actions one after another, so two actions would
 * wait on each other; one action reads both at once. Each half fails on its
 * own, so a broken count does not hide the funnel.
 */
export async function getAdminHome(): Promise<{
  funnel: Loaded<ReadinessFunnel>;
  counts: Loaded<Awaited<ReturnType<typeof contributionCounts>>>;
}> {
  await checkAuth();
  const [funnel, counts] = await Promise.all([
    settle(loadReadinessFunnel()),
    settle(contributionCounts()),
  ]);
  return { funnel, counts };
}
