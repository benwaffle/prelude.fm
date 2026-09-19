import { after } from 'next/server';
import { prepareMatchQueue, runMatchQueueWorker } from '@/lib/match-queue-processor';

export const runtime = 'nodejs';
export const maxDuration = 300;

function isAuthorized(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`);
}

async function processAndDispatchNext(requestUrl: string) {
  const result = await runMatchQueueWorker({ maxAlbums: 1 });
  const retryableFailure = result.albums.some((album) =>
    album.errors.some((error) => error.retryable),
  );
  if (result.albums.length === 0 || retryableFailure) return;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return;
  await fetch(requestUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${cronSecret}` },
    cache: 'no-store',
  });
}

function scheduleWorker(request: Request) {
  after(async () => {
    try {
      await processAndDispatchNext(request.url);
    } catch (error) {
      console.error('Match-queue worker failed:', error);
    }
  });
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // The worker chains itself through this handler, so a claim stranded by an
  // earlier link in the chain is recovered by the next one rather than waiting
  // for tomorrow's scheduled run. Only claims older than the stale window are
  // touched, so this cannot take work away from a worker that is still going.
  const prepared = await prepareMatchQueue({ maxAttempts: 5, staleMinutes: 30 });
  scheduleWorker(request);
  return Response.json({ scheduled: true, ...prepared }, { status: 202 });
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const prepared = await prepareMatchQueue({
    maxAttempts: 5,
    retryFailed: true,
    staleMinutes: 30,
  });
  scheduleWorker(request);
  return Response.json({ scheduled: true, ...prepared }, { status: 202 });
}
