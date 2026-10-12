import { after } from 'next/server';
import { prepareMatchQueue, runMatchQueueWorker } from '@/lib/match-queue-processor';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Caps self-hand-offs so a bug that always reports progress can't loop forever; the daily cron and
// next submission restart the chain.
const MAX_CHAIN_LENGTH = 200;
const CHAIN_HEADER = 'x-prelude-chain';

function isAuthorized(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`);
}

function chainDepth(request: Request) {
  const raw = Number(request.headers.get(CHAIN_HEADER) ?? '0');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

// Well under `maxDuration`, because a pass started just before the line still has to finish inside
// it.
const PASS_BUDGET_MS = 120_000;

type WorkerResult = Awaited<ReturnType<typeof runMatchQueueWorker>>;

function shouldStop(result: WorkerResult): boolean {
  // A retryable failure means the far end is unhappy; chaining straight into another attempt would
  // make that worse.
  if (result.albums.some((album) => album.errors.some((error) => error.retryable))) {
    return true;
  }
  // Spent budget or a paused gateway stops the chain rather than retrying it.
  if (result.musicbrainz.stopped) return true;
  // A broken cache invariant stops the chain rather than writing more on top of it.
  if (result.brokenInvariants.length > 0) return true;

  // Re-asking for works MusicBrainz no longer returns is not progress.
  const progressed =
    result.albums.length > 0 ||
    result.albumsRechecked > 0 ||
    result.musicbrainz.worksRead > 0 ||
    result.musicbrainz.recordingsRead > 0 ||
    result.musicbrainz.artistsRead > 0;
  return !progressed;
}

// In production, the production domain: deployment protection can refuse the deployment URL a cron
// arrives on. Elsewhere, back to this host so a preview never hands work to production.
function nextLinkUrl(requestUrl: string) {
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (process.env.VERCEL_ENV === 'production' && production) {
    return `https://${production}${new URL(requestUrl).pathname}`;
  }
  return requestUrl;
}

async function processAndDispatchNext(requestUrl: string, depth: number) {
  const started = Date.now();
  for (;;) {
    const result = await runMatchQueueWorker({ maxAlbums: 1 });
    if (shouldStop(result)) return;
    if (Date.now() - started >= PASS_BUDGET_MS) break;
  }
  if (depth + 1 >= MAX_CHAIN_LENGTH) return;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return;
  const response = await fetch(nextLinkUrl(requestUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${cronSecret}`, [CHAIN_HEADER]: String(depth + 1) },
    cache: 'no-store',
  });
  if (!response.ok) {
    console.error(`Match-queue hand-off refused: ${response.status} ${response.statusText}`);
  }
}

function scheduleWorker(request: Request) {
  const depth = chainDepth(request);
  after(async () => {
    try {
      await processAndDispatchNext(request.url, depth);
    } catch (error) {
      console.error('Match-queue worker failed:', error);
    }
  });
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Recovers claims stranded by an earlier link; only claims past the stale window, so a live
  // worker keeps its work.
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
