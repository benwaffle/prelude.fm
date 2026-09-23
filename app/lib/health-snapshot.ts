import { sql } from 'drizzle-orm';
import type { InvariantHealth } from '@/lib/musicbrainz-invariant-health';

type Database = (typeof import('@/lib/db'))['db'];

export const HEALTH_CACHE_TTL_MS = 30_000;

export type HealthSnapshot = {
  commit: string | null;
  branch: string | null;
  environment: string;
  reader: string;
  pipeline: string;
  migrations: { count: number | null; latest: number | null };
  rows: {
    spotifyTracks: number | null;
    anchors: number | null;
    releases: number | null;
    recordings: number | null;
    works: number | null;
    submissions: number | null;
    queued: number | null;
  };
  invariants: InvariantHealth;
};

async function count(database: Database, table: string): Promise<number | null> {
  try {
    const [row] = await database.all<{ n: number }>(
      sql.raw(`select count(*) as n from "${table}"`),
    );
    return Number(row?.n ?? 0);
  } catch {
    return null;
  }
}

async function appliedMigrations(database: Database) {
  try {
    const rows = await database.all<{ created_at: number }>(
      sql.raw('select created_at from __drizzle_migrations order by created_at'),
    );
    return { count: rows.length, latest: rows.at(-1)?.created_at ?? null };
  } catch {
    return { count: null, latest: null };
  }
}

export async function buildHealthSnapshot(): Promise<HealthSnapshot> {
  const [{ db }, { latestInvariantResults, musicBrainzInvariantHealth }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/musicbrainz-invariants'),
  ]);

  const [migrations, invariants, ...counts] = await Promise.all([
    appliedMigrations(db),
    latestInvariantResults(),
    count(db, 'spotify_track'),
    count(db, 'track_recording'),
    count(db, 'mb_release'),
    count(db, 'mb_recording'),
    count(db, 'mb_work'),
    count(db, 'mb_submission'),
    count(db, 'match_queue'),
  ]);
  const [spotifyTracks, anchors, releases, recordings, works, submissions, queued] = counts;

  return {
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    environment: process.env.VERCEL_ENV ?? 'development',
    reader: 'musicbrainz',
    pipeline: 'musicbrainz',
    migrations,
    rows: { spotifyTracks, anchors, releases, recordings, works, submissions, queued },
    invariants: musicBrainzInvariantHealth(invariants),
  };
}

let cached: { snapshot: HealthSnapshot; expiresAt: number } | null = null;

export function resetHealthCache(): void {
  cached = null;
}

export async function getHealthSnapshot(
  options: {
    now?: number;
    ttlMs?: number;
    load?: () => Promise<HealthSnapshot>;
  } = {},
): Promise<HealthSnapshot> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? HEALTH_CACHE_TTL_MS;
  const load = options.load ?? buildHealthSnapshot;

  if (cached && cached.expiresAt > now) return cached.snapshot;

  const snapshot = await load();
  cached = { snapshot, expiresAt: now + ttlMs };
  return snapshot;
}
