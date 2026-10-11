'use server';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { matchQueue } from '@/lib/db/schema';
import { headers } from 'next/headers';
import { after } from 'next/server';
import { inArray } from 'drizzle-orm';
import { enqueueAlbumsForTracks } from '@/lib/match-queue-processor';

export async function getSpotifyToken(): Promise<string> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error('Unauthorized');
  }

  const tokenResponse = await auth.api.getAccessToken({
    body: {
      providerId: 'spotify',
      userId: session.user.id,
    },
    headers: await headers(),
  });

  if (!tokenResponse?.accessToken) {
    throw new Error('No Spotify access token');
  }

  return tokenResponse.accessToken;
}

export async function submitToMatchQueue(trackIds: string[]): Promise<{
  submitted: number;
  expanded: number;
  alreadyQueued: number;
  processingScheduled: number;
  queuedTrackIds: string[];
}> {
  if (trackIds.length === 0) {
    return {
      submitted: 0,
      expanded: 0,
      alreadyQueued: 0,
      processingScheduled: 0,
      queuedTrackIds: [],
    };
  }

  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error('Unauthorized');
  }

  const enqueueResult = await enqueueAlbumsForTracks(trackIds, session.user.id);
  const requestHeaders = await headers();
  const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
  const protocol = requestHeaders.get('x-forwarded-proto') ?? 'https';
  const cronSecret = process.env.CRON_SECRET;
  const processingScheduled = enqueueResult.submitted > 0 && host && cronSecret ? 1 : 0;

  if (processingScheduled) {
    after(async () => {
      try {
        await fetch(`${protocol}://${host}/api/cron/match-queue`, {
          method: 'POST',
          headers: { authorization: `Bearer ${cronSecret}` },
          cache: 'no-store',
        });
      } catch (error) {
        console.error('Failed to dispatch match-queue processing:', error);
      }
    });
  }

  return {
    submitted: enqueueResult.submitted,
    expanded: enqueueResult.expanded,
    alreadyQueued: enqueueResult.alreadyQueued,
    processingScheduled: Number(processingScheduled),
    queuedTrackIds: enqueueResult.queuedTrackIds,
  };
}

export async function getQueuedTrackIds(trackIds: string[]): Promise<string[]> {
  if (trackIds.length === 0) return [];

  const results = await db
    .select({ spotifyId: matchQueue.spotifyId })
    .from(matchQueue)
    .where(inArray(matchQueue.spotifyId, trackIds));

  return results.map((r) => r.spotifyId);
}
