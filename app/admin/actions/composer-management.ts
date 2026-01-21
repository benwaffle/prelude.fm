'use server';

import { db } from '@/lib/db';
import { composer, spotifyArtist, work } from '@/lib/db/schema';
import { count, eq, like } from 'drizzle-orm';
import { checkAuth } from './auth';
import type { ComposerRow } from './schema-types';

export async function createComposerWithSpotify(data: {
  name: string;
  spotifyArtistId: string;
  birthYear?: number | null;
  deathYear?: number | null;
  popularity?: number | null;
  images?: { url: string; width: number; height: number }[] | null;
}): Promise<ComposerRow> {
  await checkAuth();

  const [existingBySpotify] = await db
    .select()
    .from(composer)
    .where(eq(composer.spotifyArtistId, data.spotifyArtistId))
    .limit(1);

  if (existingBySpotify) {
    return existingBySpotify;
  }

  await db
    .insert(spotifyArtist)
    .values({
      spotifyId: data.spotifyArtistId,
      name: data.name,
      popularity: data.popularity ?? null,
      images: data.images ?? null,
    })
    .onConflictDoUpdate({
      target: spotifyArtist.spotifyId,
      set: {
        name: data.name,
        popularity: data.popularity ?? null,
        images: data.images ?? null,
      },
    });

  const [existingByName] = await db
    .select()
    .from(composer)
    .where(eq(composer.name, data.name))
    .limit(1);

  if (existingByName) {
    const [updated] = await db
      .update(composer)
      .set({
        spotifyArtistId: data.spotifyArtistId,
        birthYear: data.birthYear ?? existingByName.birthYear,
        deathYear: data.deathYear ?? existingByName.deathYear,
      })
      .where(eq(composer.id, existingByName.id))
      .returning();
    return updated;
  }

  const [result] = await db
    .insert(composer)
    .values({
      name: data.name,
      spotifyArtistId: data.spotifyArtistId,
      birthYear: data.birthYear ?? null,
      deathYear: data.deathYear ?? null,
    })
    .returning();

  return result;
}

export async function searchComposers(query: string): Promise<ComposerRow[]> {
  await checkAuth();

  if (!query.trim()) {
    return db.select().from(composer).orderBy(composer.name).limit(50);
  }

  return db
    .select()
    .from(composer)
    .where(like(composer.name, `%${query}%`))
    .orderBy(composer.name)
    .limit(50);
}

export async function getComposersWithStats(): Promise<
  Array<
    ComposerRow & {
      workCount: number;
      spotifyImages?: { url: string; width: number; height: number }[] | null;
      spotifyPopularity?: number | null;
    }
  >
> {
  await checkAuth();

  const results = await db
    .select({
      id: composer.id,
      name: composer.name,
      birthYear: composer.birthYear,
      deathYear: composer.deathYear,
      biography: composer.biography,
      spotifyArtistId: composer.spotifyArtistId,
      spotifyImages: spotifyArtist.images,
      spotifyPopularity: spotifyArtist.popularity,
      workCount: count(work.id),
    })
    .from(composer)
    .leftJoin(work, eq(composer.id, work.composerId))
    .leftJoin(spotifyArtist, eq(composer.spotifyArtistId, spotifyArtist.spotifyId))
    .groupBy(composer.id)
    .orderBy(composer.name);

  return results;
}

export async function updateComposerDetails(
  composerId: number,
  data: {
    name?: string;
    birthYear?: number | null;
    deathYear?: number | null;
    biography?: string | null;
  },
): Promise<ComposerRow> {
  await checkAuth();

  const updateData: Partial<typeof composer.$inferInsert> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.birthYear !== undefined) updateData.birthYear = data.birthYear;
  if (data.deathYear !== undefined) updateData.deathYear = data.deathYear;
  if (data.biography !== undefined) updateData.biography = data.biography;

  const [result] = await db
    .update(composer)
    .set(updateData)
    .where(eq(composer.id, composerId))
    .returning();

  if (!result) {
    throw new Error('Composer not found');
  }

  return result;
}
