'use server';

import type { ReadinessFunnel } from '@/lib/catalogue-readiness';
import { contributionCounts } from '@/lib/gaps/counts';
import { albumWindowView, readAlbumWindow, type AlbumWindowView } from '@/lib/gaps/album-window';
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

// One action, not two: Next runs a page's server actions serially. Each half fails on its own.
// Both cover one window of albums (`from`, in Spotify ID order), never the whole library.
export async function getAdminHome(from: string | null = null): Promise<{
  window: AlbumWindowView;
  funnel: Loaded<ReadinessFunnel>;
  counts: Loaded<Awaited<ReturnType<typeof contributionCounts>>>;
}> {
  await checkAuth();
  const window = await readAlbumWindow(from);
  const [funnel, counts] = await Promise.all([
    settle(loadReadinessFunnel(window.albumIds)),
    settle(contributionCounts(window.albumIds)),
  ]);
  return { window: albumWindowView(window), funnel, counts };
}
