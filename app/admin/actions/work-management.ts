'use server';

import { db } from '@/lib/db';
import { composer, movement, recording, spotifyAlbum, trackMovement, work } from '@/lib/db/schema';
import { and, count, eq, like, or, sql } from 'drizzle-orm';
import { checkAuth } from './auth';
import type { ComposerRow, MovementRow, RecordingRow, WorkRow } from './schema-types';

export interface WorkWithDetails extends WorkRow {
  composerName: string;
  movementCount: number;
  recordingCount: number;
}

export async function searchWorks(
  query?: string,
  composerId?: number,
  catalogSystem?: string,
  limit = 50,
  offset = 0,
): Promise<{ items: WorkWithDetails[]; total: number }> {
  await checkAuth();

  const conditions = [];
  if (query?.trim()) {
    const searchPattern = `%${query}%`;
    conditions.push(
      or(
        like(work.title, searchPattern),
        like(work.nickname, searchPattern),
        like(work.catalogNumber, searchPattern),
      ),
    );
  }
  if (composerId !== undefined) {
    conditions.push(eq(work.composerId, composerId));
  }
  if (catalogSystem?.trim()) {
    conditions.push(eq(work.catalogSystem, catalogSystem));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const itemsQuery = db
    .select({
      id: work.id,
      composerId: work.composerId,
      title: work.title,
      nickname: work.nickname,
      catalogSystem: work.catalogSystem,
      catalogNumber: work.catalogNumber,
      yearComposed: work.yearComposed,
      form: work.form,
      composerName: composer.name,
      movementCount: sql<number>`(SELECT COUNT(*) FROM movement WHERE movement.work_id = ${work.id})`,
      recordingCount: sql<number>`(SELECT COUNT(*) FROM recording WHERE recording.work_id = ${work.id})`,
    })
    .from(work)
    .innerJoin(composer, eq(work.composerId, composer.id))
    .where(whereClause)
    .orderBy(composer.name, work.catalogSystem, work.catalogNumber, work.title)
    .limit(limit)
    .offset(offset);

  const totalQuery = db.select({ count: count() }).from(work).where(whereClause);

  const [items, [{ count: total }]] = await Promise.all([itemsQuery, totalQuery]);

  return { items: items as WorkWithDetails[], total };
}

export async function getWorkWithDetails(workId: number): Promise<{
  work: WorkRow;
  composer: ComposerRow;
  movements: MovementRow[];
  recordings: Array<RecordingRow & { albumTitle: string }>;
} | null> {
  await checkAuth();

  const [workRow] = await db.select().from(work).where(eq(work.id, workId)).limit(1);
  if (!workRow) return null;

  const [composerRow] = await db
    .select()
    .from(composer)
    .where(eq(composer.id, workRow.composerId))
    .limit(1);

  const movementsData = await db
    .select()
    .from(movement)
    .where(eq(movement.workId, workId))
    .orderBy(movement.number);

  const recordingsData = await db
    .select({
      id: recording.id,
      spotifyAlbumId: recording.spotifyAlbumId,
      workId: recording.workId,
      popularity: recording.popularity,
      albumTitle: spotifyAlbum.title,
    })
    .from(recording)
    .innerJoin(spotifyAlbum, eq(recording.spotifyAlbumId, spotifyAlbum.spotifyId))
    .where(eq(recording.workId, workId));

  return {
    work: workRow,
    composer: composerRow,
    movements: movementsData,
    recordings: recordingsData,
  };
}

export async function createWork(data: {
  composerId: number;
  title: string;
  nickname?: string | null;
  catalogSystem?: string | null;
  catalogNumber?: string | null;
  yearComposed?: number | null;
  form?: string | null;
}): Promise<WorkRow> {
  await checkAuth();

  const [result] = await db
    .insert(work)
    .values({
      composerId: data.composerId,
      title: data.title,
      nickname: data.nickname ?? null,
      catalogSystem: data.catalogSystem ?? null,
      catalogNumber: data.catalogNumber ?? null,
      yearComposed: data.yearComposed ?? null,
      form: data.form ?? null,
    })
    .returning();

  return result;
}

export async function updateWorkDetails(
  workId: number,
  data: {
    title?: string;
    nickname?: string | null;
    catalogSystem?: string | null;
    catalogNumber?: string | null;
    yearComposed?: number | null;
    form?: string | null;
  },
): Promise<WorkRow> {
  await checkAuth();

  const updateData: Partial<typeof work.$inferInsert> = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.nickname !== undefined) updateData.nickname = data.nickname;
  if (data.catalogSystem !== undefined) updateData.catalogSystem = data.catalogSystem;
  if (data.catalogNumber !== undefined) updateData.catalogNumber = data.catalogNumber;
  if (data.yearComposed !== undefined) updateData.yearComposed = data.yearComposed;
  if (data.form !== undefined) updateData.form = data.form;

  const [result] = await db.update(work).set(updateData).where(eq(work.id, workId)).returning();

  if (!result) {
    throw new Error('Work not found');
  }

  return result;
}

export async function addMovementToWork(
  workId: number,
  number: number,
  title?: string | null,
): Promise<MovementRow> {
  await checkAuth();

  const [result] = await db
    .insert(movement)
    .values({
      workId,
      number,
      title: title ?? null,
    })
    .returning();

  return result;
}

export async function updateMovementDetails(
  movementId: number,
  data: { number?: number; title?: string | null },
): Promise<MovementRow> {
  await checkAuth();

  const updateData: Partial<typeof movement.$inferInsert> = {};
  if (data.number !== undefined) updateData.number = data.number;
  if (data.title !== undefined) updateData.title = data.title;

  const [result] = await db
    .update(movement)
    .set(updateData)
    .where(eq(movement.id, movementId))
    .returning();

  if (!result) {
    throw new Error('Movement not found');
  }

  return result;
}

export async function deleteMovement(movementId: number): Promise<void> {
  await checkAuth();

  const [linkedTrack] = await db
    .select()
    .from(trackMovement)
    .where(eq(trackMovement.movementId, movementId))
    .limit(1);

  if (linkedTrack) {
    throw new Error('Cannot delete movement: tracks are linked to it');
  }

  await db.delete(movement).where(eq(movement.id, movementId));
}
