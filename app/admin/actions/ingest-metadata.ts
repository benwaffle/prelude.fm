'use server';

import { db } from '@/lib/db';
import {
  composer,
  spotifyAlbum,
  spotifyArtist,
  spotifyTrack,
  trackArtists,
  trackMovement,
  work,
  movement,
} from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { checkAuth } from './auth';
import { linkTrackMovement, upsertMovement, upsertRecording, upsertWork } from './spotify-utils';

export async function saveTrackWithMetadata(data: {
  album: {
    id: string;
    name: string;
    release_date: string;
    popularity: number;
    images: { url: string; width: number; height: number }[];
    inSpotifyAlbumsTable: boolean;
  };
  track: {
    id: string;
    name: string;
    uri: string;
    duration_ms: number;
    track_number: number;
    popularity: number;
    inSpotifyTracksTable: boolean;
  };
  artists: { id: string; name: string; inSpotifyArtistsTable: boolean; composerId?: number }[];
  metadata: {
    composerArtistId: string;
    composerName: string;
    formalName: string;
    nickname: string | null;
    catalogSystem: string | null;
    catalogNumber: string | null;
    form: string | null;
    movementNumber: number;
    movementName: string | null;
    yearComposed: number | null;
  };
}) {
  await checkAuth();

  const { album, track, artists, metadata } = data;

  const albumPromise = !album.inSpotifyAlbumsTable
    ? db
        .insert(spotifyAlbum)
        .values({
          spotifyId: album.id,
          title: album.name,
          year: album.release_date ? parseInt(album.release_date.split('-')[0]) : null,
          images: album.images,
          popularity: album.popularity || null,
        })
        .onConflictDoUpdate({
          target: spotifyAlbum.spotifyId,
          set: { title: album.name, popularity: album.popularity || null },
        })
    : Promise.resolve();

  const artistsToSave = artists.filter((a) => !a.inSpotifyArtistsTable);
  const artistPromises = artistsToSave.map((artist) =>
    db
      .insert(spotifyArtist)
      .values({
        spotifyId: artist.id,
        name: artist.name,
        popularity: null,
        images: null,
      })
      .onConflictDoNothing(),
  );

  await Promise.all([albumPromise, ...artistPromises]);

  let composerId = artists.find((a) => a.id === metadata.composerArtistId)?.composerId;

  if (!composerId) {
    const [existing] = await db
      .select()
      .from(composer)
      .where(eq(composer.spotifyArtistId, metadata.composerArtistId))
      .limit(1);

    if (existing) {
      composerId = existing.id;
    } else {
      const result = await db
        .insert(composer)
        .values({
          name: metadata.composerName,
          spotifyArtistId: metadata.composerArtistId,
        })
        .returning({ id: composer.id });
      composerId = result[0].id;
    }
  }

  if (!track.inSpotifyTracksTable) {
    await db
      .insert(spotifyTrack)
      .values({
        spotifyId: track.id,
        title: track.name,
        trackNumber: track.track_number,
        durationMs: track.duration_ms,
        popularity: track.popularity,
        spotifyAlbumId: album.id,
      })
      .onConflictDoNothing();

    await Promise.all(
      artists.map((artist) =>
        db
          .insert(trackArtists)
          .values({
            spotifyTrackId: track.id,
            spotifyArtistId: artist.id,
          })
          .onConflictDoNothing(),
      ),
    );
  }

  const workId = await upsertWork({
    composerId,
    title: metadata.formalName,
    nickname: metadata.nickname,
    catalogSystem: metadata.catalogSystem,
    catalogNumber: metadata.catalogNumber,
    yearComposed: metadata.yearComposed,
    form: metadata.form,
  });

  const movementId = await upsertMovement({
    workId,
    number: metadata.movementNumber,
    title: metadata.movementName,
  });

  const recordingId = await upsertRecording({
    spotifyAlbumId: album.id,
    workId,
  });

  await linkTrackMovement({
    spotifyTrackId: track.id,
    movementId,
  });

  return { success: true, workId, movementId, recordingId, composerId };
}

export async function checkWorksExist(
  queries: { catalogSystem: string; catalogNumber: string }[],
): Promise<
  Record<string, { workId: number; movements: { number: number; title: string | null }[] }>
> {
  await checkAuth();

  if (queries.length === 0) return {};

  try {
    const allWorks = await db
      .select({
        id: work.id,
        catalogSystem: work.catalogSystem,
        catalogNumber: work.catalogNumber,
      })
      .from(work)
      .where(
        inArray(
          work.catalogSystem,
          queries.map((q) => q.catalogSystem),
        ),
      );

    const result: Record<
      string,
      { workId: number; movements: { number: number; title: string | null }[] }
    > = {};
    const matchingWorkIds: number[] = [];

    for (const w of allWorks) {
      if (!w.catalogSystem || !w.catalogNumber) continue;
      const key = `${w.catalogSystem}:${w.catalogNumber}`;
      if (
        queries.some(
          (q) => q.catalogSystem === w.catalogSystem && q.catalogNumber === w.catalogNumber,
        )
      ) {
        result[key] = { workId: w.id, movements: [] };
        matchingWorkIds.push(w.id);
      }
    }

    if (matchingWorkIds.length > 0) {
      const movements = await db
        .select({
          workId: movement.workId,
          number: movement.number,
          title: movement.title,
        })
        .from(movement)
        .where(inArray(movement.workId, matchingWorkIds));

      for (const m of movements) {
        for (const value of Object.values(result)) {
          if (value.workId === m.workId) {
            value.movements.push({ number: m.number, title: m.title });
          }
        }
      }
    }

    return result;
  } catch (error) {
    console.error('Error checking works:', error);
    throw new Error('Failed to check works');
  }
}

export async function deleteTrackMetadata(spotifyTrackId: string) {
  await checkAuth();

  try {
    await db.delete(trackMovement).where(eq(trackMovement.spotifyTrackId, spotifyTrackId));

    return {
      success: true,
      message: 'Track-movement link removed, ready for re-analysis',
    };
  } catch (error) {
    console.error('Error removing track-movement link:', error);
    throw new Error('Failed to remove track-movement link');
  }
}
