import { after } from 'next/server';
import { prepareMatchQueue, runMatchQueueWorker } from '@/lib/match-queue-processor';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * How many times the worker may hand off to itself from one trigger.
 *
 * The chain is what makes processing continuous: a daily cron cannot serve a
 * signup, and each link does a few albums or slices of the MusicBrainz sweep
 * before passing on. The cap exists so that a bug which always reports
 * progress cannot invoke this route forever — the daily cron and the next
 * submission both start a fresh chain, so a cap costs a delay, not the work.
 */
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

/**
 * How long one invocation keeps starting passes before handing off.
 *
 * Each pass is one album or one slice of the MusicBrainz sweep, so running
 * several here does not depend on the hand-off arriving. Well under
 * `maxDuration`, because a pass started just before the line still has to
 * finish inside it.
 */
const PASS_BUDGET_MS = 120_000;

type WorkerResult = Awaited<ReturnType<typeof runMatchQueueWorker>>;

/** Whether this pass gives a reason to stop rather than run another. */
function shouldStop(result: WorkerResult): boolean {
  // A retryable failure means the far end is unhappy; chaining straight into
  // another attempt would make that worse. The daily run and the next
  // submission both restart the chain.
  if (result.albums.some((album) => album.errors.some((error) => error.retryable))) {
    return true;
  }
  // The budget being spent or the gateway being paused is a reason to stop
  // the chain, not a reason to retry it.
  if (result.musicbrainz.stopped) return true;
  // A broken cache invariant stops the chain rather than writing more on top
  // of it. Admin shows what broke.
  if (result.brokenInvariants.length > 0) return true;

  // Asking again for works MusicBrainz no longer returns is not progress, or
  // a cache holding only those would be asked for them link after link.
  const progressed =
    result.albums.length > 0 ||
    result.musicbrainz.worksRead > 0 ||
    result.musicbrainz.recordingsRead > 0 ||
    result.musicbrainz.artistsRead > 0;
  return !progressed;
}

/**
 * Where the next link is sent.
 *
 * In production, the production domain rather than the URL this request
 * arrived on: a cron is delivered to the deployment's own URL, which
 * deployment protection can refuse, and a refused hand-off ends the chain
 * after one album. Elsewhere, back to wherever this one ran, so a preview
 * never hands work to production.
 */
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
