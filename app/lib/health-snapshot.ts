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
  invariants: InvariantHealth;
};

// No row counts: Turso bills each row a `count(*)` reads, and with the MusicBrainz dump in, the
// tables this once counted hold millions, on an endpoint anyone may probe. `pnpm mb:ingest report`
// and `pnpm spotify:crawl report` count them on demand.

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

  const [migrations, invariants] = await Promise.all([
    appliedMigrations(db),
    latestInvariantResults(),
  ]);

  return {
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    environment: process.env.VERCEL_ENV ?? 'development',
    reader: 'musicbrainz',
    pipeline: 'musicbrainz',
    migrations,
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
