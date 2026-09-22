import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { latestInvariantResults, musicBrainzInvariantHealth } from '@/lib/musicbrainz-invariants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What is actually deployed, and what it is talking to.
 *
 * Every verification step in the deployment plan — did this commit reach
 * production, is the production schema the one this code expects, were the
 * invariants clean when we cut over — needs these three facts together, and
 * correlating them by hand across a git log, a Vercel dashboard and a
 * database shell is how the wrong answer gets recorded in a deployment log.
 *
 * Read-only, and never public: it names table sizes and the commit running.
 */
async function count(table: string): Promise<number | null> {
  try {
    const [row] = await db.all<{ n: number }>(sql.raw(`select count(*) as n from "${table}"`));
    return Number(row?.n ?? 0);
  } catch {
    // A table the deployed schema does not have yet is itself the answer.
    return null;
  }
}

async function appliedMigrations() {
  try {
    const rows = await db.all<{ created_at: number }>(
      sql.raw('select created_at from __drizzle_migrations order by created_at'),
    );
    return { count: rows.length, latest: rows.at(-1)?.created_at ?? null };
  } catch {
    return { count: null, latest: null };
  }
}

async function isAuthorized(request: Request): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`) return true;
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user.name === 'benwaffle';
}

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [migrations, invariants, ...counts] = await Promise.all([
    appliedMigrations(),
    latestInvariantResults(),
    count('spotify_track'),
    count('track_recording'),
    count('mb_release'),
    count('mb_recording'),
    count('mb_work'),
    count('mb_submission'),
    count('match_queue'),
  ]);
  const [spotifyTracks, anchors, releases, recordings, works, submissions, queued] = counts;

  return Response.json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    environment: process.env.VERCEL_ENV ?? 'development',
    reader: process.env.NEXT_PUBLIC_READER ?? 'legacy',
    pipeline: process.env.PIPELINE ?? 'legacy',
    migrations,
    rows: { spotifyTracks, anchors, releases, recordings, works, submissions, queued },
    invariants: musicBrainzInvariantHealth(invariants),
  });
}
