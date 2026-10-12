/** This module owns which value type goes with which stage. */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { mbMissingRelease, spotifyAlbum } from './db/schema';
import type { ReleaseCorrectionRecord } from './release-corrections';
import type { ReleasePrecheck } from './release-precheck';
import type { SeedPlan } from './release-seeding';

type StageValues = {
  precheck: ReleasePrecheck;
  seed: SeedPlan;
  seeded: SeedPlan;
  correction: ReleaseCorrectionRecord;
};

export type MissingReleaseStage = keyof StageValues;

export type StoredStage<T> = {
  value: T;
  /** Null for corrections measured before they were counted. */
  requests: number | null;
  recordedAt: Date;
};

export type MissingRelease = { [S in MissingReleaseStage]?: StoredStage<StageValues[S]> };

/** Spends no MusicBrainz requests. */
export async function readMissingReleases(
  albumIds: string[],
): Promise<Map<string, MissingRelease>> {
  const out = new Map<string, MissingRelease>();
  if (albumIds.length === 0) return out;
  const rows = await db
    .select()
    .from(mbMissingRelease)
    .where(inArray(mbMissingRelease.spotifyAlbumId, albumIds));
  for (const row of rows) {
    const album = out.get(row.spotifyAlbumId) ?? {};
    // The stage column says which type the value is; only `writeMissingRelease` writes it.
    (album as Record<MissingReleaseStage, StoredStage<unknown>>)[row.stage] = {
      value: row.value,
      requests: row.requests,
      recordedAt: row.recordedAt,
    };
    out.set(row.spotifyAlbumId, album);
  }
  return out;
}

export async function writeMissingRelease<S extends MissingReleaseStage>(
  albumId: string,
  stage: S,
  value: StageValues[S],
  requests: number,
): Promise<void> {
  const recordedAt = new Date();
  await db
    .insert(mbMissingRelease)
    .values({ spotifyAlbumId: albumId, stage, value, requests, recordedAt })
    .onConflictDoUpdate({
      target: [mbMissingRelease.spotifyAlbumId, mbMissingRelease.stage],
      set: { value, requests, recordedAt },
    });
}

/** One statement, so `seeded` is exactly the plan they opened. */
export async function markReleaseSeeded(albumId: string): Promise<void> {
  await db.run(sql`
    insert into ${mbMissingRelease} (spotify_album_id, stage, value, requests, recorded_at)
    select spotify_album_id, 'seeded', value, 0, ${Date.now()}
    from ${mbMissingRelease}
    where spotify_album_id = ${albumId} and stage = 'seed'
    on conflict (spotify_album_id, stage) do update
      set value = excluded.value, requests = excluded.requests, recorded_at = excluded.recorded_at
  `);
}

export type CorrectionRow = {
  albumId: string;
  albumTitle: string | null;
  measuredAt: Date;
  record: ReleaseCorrectionRecord;
};

export async function correctionRecords(): Promise<CorrectionRow[]> {
  const rows = await db
    .select({
      albumId: mbMissingRelease.spotifyAlbumId,
      albumTitle: spotifyAlbum.title,
      measuredAt: mbMissingRelease.recordedAt,
      value: mbMissingRelease.value,
    })
    .from(mbMissingRelease)
    .leftJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, mbMissingRelease.spotifyAlbumId))
    .where(eq(mbMissingRelease.stage, 'correction'))
    .orderBy(desc(mbMissingRelease.recordedAt));
  return rows.map(({ value, ...row }) => ({ ...row, record: value as ReleaseCorrectionRecord }));
}
