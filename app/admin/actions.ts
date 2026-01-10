"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  composer,
  spotifyArtist,
  spotifyAlbum,
  spotifyTrack,
  trackArtists,
  work,
  movement,
  trackMovement,
  recording,
} from "@/lib/db/schema";
import { headers } from "next/headers";
import { eq, and, inArray, type InferSelectModel } from "drizzle-orm";
import { createSpotifySdk } from "@/lib/spotify-sdk";
import type { Image as SpotifyImage, Track as SpotifyTrack } from "@spotify/web-api-ts-sdk";

// Export types for use in UI components
export type SpotifyTrackRow = InferSelectModel<typeof spotifyTrack>;
export type SpotifyAlbumRow = InferSelectModel<typeof spotifyAlbum>;
export type SpotifyArtistRow = InferSelectModel<typeof spotifyArtist>;
export type ComposerRow = InferSelectModel<typeof composer>;
export type WorkRow = InferSelectModel<typeof work>;
export type MovementRow = InferSelectModel<typeof movement>;
export type TrackMovementRow = InferSelectModel<typeof trackMovement>;
export type RecordingRow = InferSelectModel<typeof recording>;

// Return type for getBatchTrackMetadata
export interface TrackMetadata {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  disc_number: number;
  track_number: number;
  popularity: number;
  inSpotifyTracksTable: boolean;
  artists: Array<{
    id: string;
    name: string;
    uri: string;
    inSpotifyArtistsTable: boolean;
    inComposersTable: boolean;
    composerId?: number;
  }>;
  album: {
    id: string;
    name: string;
    uri: string;
    release_date: string;
    popularity: number;
    images: SpotifyImage[];
    inSpotifyAlbumsTable: boolean;
  };
  dbData: {
    track: SpotifyTrackRow | null;
    album: SpotifyAlbumRow | null;
    artists: SpotifyArtistRow[];
    composers: ComposerRow[];
    trackMovements: TrackMovementRow[];
    movements: MovementRow[];
    works: WorkRow[];
    recordings: RecordingRow[];
  };
}

async function checkAuth() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error("Unauthorized");
  }

  if (session.user.name !== "benwaffle") {
    throw new Error("Access denied");
  }

  return session;
}

async function getSpotifyAccessToken(userId: string) {
  const tokenResponse = await auth.api.getAccessToken({
    body: {
      providerId: "spotify",
      userId,
    },
    headers: await headers(),
  });

  if (!tokenResponse?.accessToken) {
    throw new Error("No Spotify access token");
  }

  return tokenResponse.accessToken;
}

// Consolidated action to save a track with all metadata in one round-trip
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
    key: string | null;
    form: string | null;
    movementNumber: number;
    movementName: string | null;
    yearComposed: number | null;
  };
}) {
  await checkAuth();

  const { album, track, artists, metadata } = data;

  // Step 1: Insert album and artists in parallel (independent operations)
  const albumPromise = !album.inSpotifyAlbumsTable
    ? db.insert(spotifyAlbum).values({
        spotifyId: album.id,
        title: album.name,
        year: album.release_date ? parseInt(album.release_date.split("-")[0]) : null,
        images: album.images,
        popularity: album.popularity || null,
      }).onConflictDoUpdate({
        target: spotifyAlbum.spotifyId,
        set: { title: album.name, popularity: album.popularity || null },
      })
    : Promise.resolve();

  const artistsToSave = artists.filter(a => !a.inSpotifyArtistsTable);
  const artistPromises = artistsToSave.map(artist =>
    db.insert(spotifyArtist).values({
      spotifyId: artist.id,
      name: artist.name,
      popularity: null,
      images: null,
    }).onConflictDoNothing()
  );

  await Promise.all([albumPromise, ...artistPromises]);

  // Step 2: Get or create composer
  const composerArtist = artists.find(a => a.id === metadata.composerArtistId);
  let composerId = composerArtist?.composerId;

  if (!composerId) {
    const [existing] = await db
      .select()
      .from(composer)
      .where(eq(composer.spotifyArtistId, metadata.composerArtistId))
      .limit(1);

    if (existing) {
      composerId = existing.id;
    } else {
      const result = await db.insert(composer).values({
        name: metadata.composerName,
        spotifyArtistId: metadata.composerArtistId,
      }).returning({ id: composer.id });
      composerId = result[0].id;
    }
  }

  // Step 3: Insert track (depends on album being inserted)
  if (!track.inSpotifyTracksTable) {
    await db.insert(spotifyTrack).values({
      spotifyId: track.id,
      title: track.name,
      trackNumber: track.track_number,
      durationMs: track.duration_ms,
      popularity: track.popularity,
      spotifyAlbumId: album.id,
    }).onConflictDoNothing();

    // Insert track-artist relationships in parallel
    await Promise.all(
      artists.map(artist =>
        db.insert(trackArtists).values({
          spotifyTrackId: track.id,
          spotifyArtistId: artist.id,
        }).onConflictDoNothing()
      )
    );
  }

  // Step 4: Upsert work
  let workId: number;
  let existingWork;

  if (metadata.catalogSystem && metadata.catalogNumber) {
    [existingWork] = await db
      .select()
      .from(work)
      .where(
        and(
          eq(work.composerId, composerId),
          eq(work.catalogSystem, metadata.catalogSystem),
          eq(work.catalogNumber, metadata.catalogNumber)
        )
      )
      .limit(1);
  } else {
    [existingWork] = await db
      .select()
      .from(work)
      .where(
        and(
          eq(work.composerId, composerId),
          eq(work.title, metadata.formalName)
        )
      )
      .limit(1);
  }

  if (existingWork) {
    await db.update(work).set({
      title: metadata.formalName,
      nickname: metadata.nickname,
      catalogSystem: metadata.catalogSystem,
      catalogNumber: metadata.catalogNumber,
      yearComposed: metadata.yearComposed,
      form: metadata.form,
    }).where(eq(work.id, existingWork.id));
    workId = existingWork.id;
  } else {
    const workResult = await db.insert(work).values({
      composerId,
      title: metadata.formalName,
      nickname: metadata.nickname,
      catalogSystem: metadata.catalogSystem,
      catalogNumber: metadata.catalogNumber,
      yearComposed: metadata.yearComposed,
      form: metadata.form,
    }).returning({ id: work.id });
    workId = workResult[0].id;
  }

  // Step 5: Upsert movement
  let movementId: number;
  const [existingMovement] = await db
    .select()
    .from(movement)
    .where(and(eq(movement.workId, workId), eq(movement.number, metadata.movementNumber)))
    .limit(1);

  if (existingMovement) {
    await db.update(movement).set({ title: metadata.movementName }).where(eq(movement.id, existingMovement.id));
    movementId = existingMovement.id;
  } else {
    const movementResult = await db.insert(movement).values({
      workId,
      number: metadata.movementNumber,
      title: metadata.movementName,
    }).returning({ id: movement.id });
    movementId = movementResult[0].id;
  }

  // Step 6: Upsert recording and track-movement in parallel
  const [existingRecording] = await db
    .select()
    .from(recording)
    .where(and(eq(recording.spotifyAlbumId, album.id), eq(recording.workId, workId)))
    .limit(1);

  const recordingId = existingRecording?.id ?? (
    await db.insert(recording).values({
      spotifyAlbumId: album.id,
      workId,
      popularity: null,
    }).returning({ id: recording.id })
  )[0].id;

  await db.insert(trackMovement).values({
    spotifyTrackId: track.id,
    movementId,
    startMs: null,
    endMs: null,
  }).onConflictDoNothing();

  return { success: true, workId, movementId, recordingId, composerId };
}

export async function addAlbumToDatabase(albumData: {
  id: string;
  name: string;
  release_date: string;
  popularity: number;
  images: { url: string; width: number; height: number }[];
}) {
  await checkAuth();

  try {
    const year = albumData.release_date
      ? parseInt(albumData.release_date.split("-")[0])
      : null;

    await db
      .insert(spotifyAlbum)
      .values({
        spotifyId: albumData.id,
        title: albumData.name,
        year,
        images: albumData.images,
        popularity: albumData.popularity || null,
      })
      .onConflictDoUpdate({
        target: spotifyAlbum.spotifyId,
        set: {
          title: albumData.name,
          year,
          images: albumData.images,
          popularity: albumData.popularity || null,
        },
      });

    return {
      success: true,
      message: `Added album "${albumData.name}" to database`,
    };
  } catch (error) {
    console.error("Error adding album to database:", error);
    throw new Error("Failed to add album to database");
  }
}

function createServerSpotifyClient(accessToken: string) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    throw new Error("SPOTIFY_CLIENT_ID is not configured");
  }
  return createSpotifySdk(accessToken, clientId);
}

export async function addArtistsToDatabase(artists: { id: string; name: string }[]) {
  await checkAuth();

  try {
    // Insert all artists in parallel - skip Spotify API call, we only need names
    await Promise.all(
      artists.map((artist) =>
        db
          .insert(spotifyArtist)
          .values({
            spotifyId: artist.id,
            name: artist.name,
            popularity: null,
            images: null,
          })
          .onConflictDoUpdate({
            target: spotifyArtist.spotifyId,
            set: {
              name: artist.name,
            },
          })
      )
    );

    return {
      success: true,
      message: `Added ${artists.length} artist(s) to database`,
    };
  } catch (error) {
    console.error("Error adding artists to database:", error);
    throw new Error("Failed to add artists to database");
  }
}

export async function addTrackToDatabase(trackData: {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  track_number: number;
  popularity: number;
  albumId: string;
  artists: { id: string; name: string }[];
}) {
  await checkAuth();

  try {
    await db
      .insert(spotifyTrack)
      .values({
        spotifyId: trackData.id,
        title: trackData.name,
        trackNumber: trackData.track_number,
        durationMs: trackData.duration_ms,
        popularity: trackData.popularity,
        spotifyAlbumId: trackData.albumId,
      })
      .onConflictDoUpdate({
        target: spotifyTrack.spotifyId,
        set: {
          title: trackData.name,
          trackNumber: trackData.track_number,
          durationMs: trackData.duration_ms,
          popularity: trackData.popularity,
          spotifyAlbumId: trackData.albumId,
        },
      });

    // Upsert track-artist relationships
    for (const artist of trackData.artists) {
      await db
        .insert(trackArtists)
        .values({
          spotifyTrackId: trackData.id,
          spotifyArtistId: artist.id,
        })
        .onConflictDoNothing();
    }

    return {
      success: true,
      message: `Added track "${trackData.name}" to database`,
    };
  } catch (error) {
    console.error("Error adding track to database:", error);
    throw new Error("Failed to add track to database");
  }
}

export async function addComposer(spotifyArtistId: string, name: string) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error("Unauthorized");
  }

  if (session.user.name !== "benwaffle") {
    throw new Error("Access denied");
  }

  try {
    const { composer } = await import("@/lib/db/schema");

    // Check if composer already exists by spotifyArtistId
    const [existing] = await db
      .select()
      .from(composer)
      .where(eq(composer.spotifyArtistId, spotifyArtistId))
      .limit(1);

    if (existing) {
      return {
        success: true,
        composer: {
          id: existing.id,
          name: existing.name,
          spotifyArtistId: existing.spotifyArtistId,
        },
      };
    }

    // Insert new composer
    const result = await db.insert(composer).values({
      name,
      spotifyArtistId,
    }).returning({ id: composer.id });

    const insertedId = result[0].id;

    return {
      success: true,
      composer: {
        id: insertedId,
        name,
        spotifyArtistId,
      },
    };
  } catch (error) {
    console.error("Error adding composer:", error);
    throw new Error("Failed to add composer");
  }
}

// Check which works exist in the database by catalog numbers
export async function checkWorksExist(
  queries: { catalogSystem: string; catalogNumber: string }[]
): Promise<Record<string, { workId: number; movements: { number: number; title: string | null }[] }>> {
  await checkAuth();

  if (queries.length === 0) return {};

  try {
    // Get all works that match any of the catalog queries
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
          queries.map((q) => q.catalogSystem)
        )
      );

    // Filter to exact matches and build result object
    const result: Record<string, { workId: number; movements: { number: number; title: string | null }[] }> = {};
    const matchingWorkIds: number[] = [];

    for (const w of allWorks) {
      if (!w.catalogSystem || !w.catalogNumber) continue;
      const key = `${w.catalogSystem}:${w.catalogNumber}`;
      if (queries.some((q) => q.catalogSystem === w.catalogSystem && q.catalogNumber === w.catalogNumber)) {
        result[key] = { workId: w.id, movements: [] };
        matchingWorkIds.push(w.id);
      }
    }

    // Get movements for matching works
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
    console.error("Error checking works:", error);
    throw new Error("Failed to check works");
  }
}

export async function checkWorkAndMovement(
  composerId: number,
  catalogSystem: string | null,
  catalogNumber: string | null,
  movementNumber: number
) {
  await checkAuth();

  try {
    // Find work by composer and catalog number
    let works;
    if (catalogSystem && catalogNumber) {
      works = await db
        .select()
        .from(work)
        .where(
          and(
            eq(work.composerId, composerId),
            eq(work.catalogSystem, catalogSystem),
            eq(work.catalogNumber, catalogNumber)
          )
        );
    } else {
      // If no catalog info, we can't reliably find existing works
      // Return that it doesn't exist (will create new)
      return {
        workExists: false,
        movementExists: false,
        work: null,
        movement: null,
      };
    }

    const existingWork = works[0] || null;

    if (!existingWork) {
      return {
        workExists: false,
        movementExists: false,
        work: null,
        movement: null,
      };
    }

    // Find movement by work and movement number
    const movements = await db
      .select()
      .from(movement)
      .where(
        and(
          eq(movement.workId, existingWork.id),
          eq(movement.number, movementNumber)
        )
      );

    const existingMovement = movements[0] || null;

    return {
      workExists: true,
      movementExists: !!existingMovement,
      work: existingWork,
      movement: existingMovement,
    };
  } catch (error) {
    console.error("Error checking work and movement:", error);
    throw new Error("Failed to check work and movement");
  }
}

export async function addWorkMovementAndTrack(data: {
  composerId: number;
  formalName: string;
  nickname: string | null;
  catalogSystem: string | null;
  catalogNumber: string | null;
  key: string | null;
  form: string | null;
  movementNumber: number;
  movementName: string | null;
  yearComposed: number | null;
  spotifyTrackId: string;
  spotifyAlbumId: string;
}) {
  await checkAuth();

  try {
    // Upsert work and get its ID
    // Query first to find existing work, then insert or update
    let workId: number;
    let existingWork;

    if (data.catalogSystem && data.catalogNumber) {
      // Works WITH catalog numbers: find by (composerId, catalogSystem, catalogNumber)
      [existingWork] = await db
        .select()
        .from(work)
        .where(
          and(
            eq(work.composerId, data.composerId),
            eq(work.catalogSystem, data.catalogSystem),
            eq(work.catalogNumber, data.catalogNumber)
          )
        )
        .limit(1);
    } else {
      // Works WITHOUT catalog numbers: find by (composerId, title)
      [existingWork] = await db
        .select()
        .from(work)
        .where(
          and(
            eq(work.composerId, data.composerId),
            eq(work.title, data.formalName)
          )
        )
        .limit(1);
    }

    if (existingWork) {
      // Update existing work
      await db
        .update(work)
        .set({
          title: data.formalName,
          nickname: data.nickname,
          catalogSystem: data.catalogSystem,
          catalogNumber: data.catalogNumber,
          yearComposed: data.yearComposed,
          form: data.form,
        })
        .where(eq(work.id, existingWork.id));
      workId = existingWork.id;
    } else {
      // Insert new work
      const workResult = await db
        .insert(work)
        .values({
          composerId: data.composerId,
          title: data.formalName,
          nickname: data.nickname,
          catalogSystem: data.catalogSystem,
          catalogNumber: data.catalogNumber,
          yearComposed: data.yearComposed,
          form: data.form,
        })
        .returning({ id: work.id });
      workId = workResult[0].id;
    }

    // Upsert movement and get its ID
    let movementId: number;
    const [existingMovement] = await db
      .select()
      .from(movement)
      .where(
        and(
          eq(movement.workId, workId),
          eq(movement.number, data.movementNumber)
        )
      )
      .limit(1);

    if (existingMovement) {
      // Update existing movement
      await db
        .update(movement)
        .set({
          title: data.movementName,
        })
        .where(eq(movement.id, existingMovement.id));
      movementId = existingMovement.id;
    } else {
      // Insert new movement
      const movementResult = await db
        .insert(movement)
        .values({
          workId,
          number: data.movementNumber,
          title: data.movementName,
        })
        .returning({ id: movement.id });
      movementId = movementResult[0].id;
    }

    // Upsert recording (links album to work) and get its ID
    let recordingId: number;
    const [existingRecording] = await db
      .select()
      .from(recording)
      .where(
        and(
          eq(recording.spotifyAlbumId, data.spotifyAlbumId),
          eq(recording.workId, workId)
        )
      )
      .limit(1);

    if (existingRecording) {
      recordingId = existingRecording.id;
    } else {
      // Insert new recording
      const recordingResult = await db
        .insert(recording)
        .values({
          spotifyAlbumId: data.spotifyAlbumId,
          workId,
          popularity: null, // Will be calculated later by averaging tracks
        })
        .returning({ id: recording.id });
      recordingId = recordingResult[0].id;
    }

    // Upsert track-movement relationship
    await db
      .insert(trackMovement)
      .values({
        spotifyTrackId: data.spotifyTrackId,
        movementId,
        startMs: null,
        endMs: null,
      })
      .onConflictDoNothing();

    return {
      success: true,
      message: `Added work "${data.formalName}", movement ${data.movementNumber}, recording, and linked to track`,
      workId,
      movementId,
      recordingId,
    };
  } catch (error) {
    console.error("Error adding work, movement, and track:", error);
    throw new Error("Failed to add work, movement, and track");
  }
}

export async function deleteTrackMetadata(spotifyTrackId: string) {
  await checkAuth();

  try {
    // Only remove the track-movement relationship for this specific track.
    // The work/movement/recording data remains intact and can be reused by other tracks/recordings.
    // This allows re-analyzing this track without affecting other tracks that share the same work.

    await db.delete(trackMovement).where(eq(trackMovement.spotifyTrackId, spotifyTrackId));

    return {
      success: true,
      message: "Track-movement link removed, ready for re-analysis",
    };
  } catch (error) {
    console.error("Error removing track-movement link:", error);
    throw new Error("Failed to remove track-movement link");
  }
}

export async function getAlbumTrackIds(albumId: string): Promise<string[]> {
  const session = await checkAuth();
  const accessToken = await getSpotifyAccessToken(session.user.id);
  const spotify = createServerSpotifyClient(accessToken);

  const trackIds: string[] = [];
  let offset = 0;
  const limit = 50;

  // Fetch all tracks from the album (paginated)
  while (true) {
    const albumTracks = await spotify.albums.tracks(albumId, undefined, limit, offset);
    trackIds.push(...albumTracks.items.map((t) => t.id));

    if (albumTracks.next === null) break;
    offset += limit;
  }

  return trackIds;
}

export async function getBatchTrackMetadata(trackUris: string[]) {
  const session = await checkAuth();

  // Extract track IDs from URIs
  const trackIds: string[] = [];
  for (const trackUri of trackUris) {
    let trackId: string | null = null;

    // Try URI format first
    const uriMatch = trackUri.match(/spotify:track:([a-zA-Z0-9]+)/);
    if (uriMatch) {
      trackId = uriMatch[1];
    } else {
      // Try URL format
      const urlMatch = trackUri.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
      if (urlMatch) {
        trackId = urlMatch[1];
      }
    }

    if (trackId) {
      trackIds.push(trackId);
    }
  }

  if (trackIds.length === 0) {
    throw new Error("No valid track URIs found");
  }

  // Get Spotify access token
  const accessToken = await getSpotifyAccessToken(session.user.id);
  const spotify = createServerSpotifyClient(accessToken);

  // Fetch tracks in batches of 50 (Spotify API limit)
  const batchSize = 50;
  const allTrackData: SpotifyTrack[] = [];

  for (let i = 0; i < trackIds.length; i += batchSize) {
    const batchIds = trackIds.slice(i, i + batchSize);
    const tracks = await spotify.tracks.get(batchIds);
    allTrackData.push(...tracks);
  }

  // Get all unique artist IDs and album IDs
  const artistIds = [...new Set(allTrackData.flatMap((track) => track.artists.map((a) => a.id)))];
  const albumIds = [...new Set(allTrackData.map((track) => track.album.id))];

  // Check database for existing data
  const [existingSpotifyArtists, existingComposers, existingAlbums, existingTracks] = await Promise.all([
    artistIds.length > 0
      ? db
          .select()
          .from(spotifyArtist)
          .where(inArray(spotifyArtist.spotifyId, artistIds))
      : [],
    artistIds.length > 0
      ? db
          .select()
          .from(composer)
          .where(inArray(composer.spotifyArtistId, artistIds))
      : [],
    albumIds.length > 0
      ? db
          .select()
          .from(spotifyAlbum)
          .where(inArray(spotifyAlbum.spotifyId, albumIds))
      : [],
    trackIds.length > 0
      ? db
          .select()
          .from(spotifyTrack)
          .where(inArray(spotifyTrack.spotifyId, trackIds))
      : [],
  ]);

  const spotifyArtistMap = new Map(
    existingSpotifyArtists.map((a) => [a.spotifyId, a])
  );
  const composerMap = new Map(
    existingComposers.map((c) => [c.spotifyArtistId, c])
  );
  const albumMap = new Map(
    existingAlbums.map((a) => [a.spotifyId, a])
  );
  const trackMap = new Map(
    existingTracks.map((t) => [t.spotifyId, t])
  );

  // For tracks that exist, fetch their full database info
  const existingTrackIds = existingTracks.map((t) => t.spotifyId);
  let trackMovementsData: TrackMovementRow[] = [];
  let movementsData: MovementRow[] = [];
  let worksData: WorkRow[] = [];
  let composersData: ComposerRow[] = [];
  let recordingsData: RecordingRow[] = [];

  if (existingTrackIds.length > 0) {
    const trackMovementRecords = await db
      .select()
      .from(trackMovement)
      .where(inArray(trackMovement.spotifyTrackId, existingTrackIds));

    if (trackMovementRecords.length > 0) {
      trackMovementsData = trackMovementRecords;

      const movementIds = trackMovementRecords.map((tm) => tm.movementId);
      movementsData = await db
        .select()
        .from(movement)
        .where(inArray(movement.id, movementIds));

      const workIds = movementsData.map((m) => m.workId);
      if (workIds.length > 0) {
        worksData = await db
          .select()
          .from(work)
          .where(inArray(work.id, workIds));

        const composerIds = worksData.map((w) => w.composerId);
        if (composerIds.length > 0) {
          composersData = await db
            .select()
            .from(composer)
            .where(inArray(composer.id, composerIds));
        }

        recordingsData = await db
          .select()
          .from(recording)
          .where(inArray(recording.workId, workIds));
      }
    }
  }

  // Build result objects
  return allTrackData.map((trackData): TrackMetadata => ({
    id: trackData.id,
    name: trackData.name,
    uri: trackData.uri,
    duration_ms: trackData.duration_ms,
    disc_number: trackData.disc_number,
    track_number: trackData.track_number,
    popularity: trackData.popularity,
    inSpotifyTracksTable: trackMap.has(trackData.id),
    artists: trackData.artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      uri: artist.uri,
      inSpotifyArtistsTable: spotifyArtistMap.has(artist.id),
      inComposersTable: composerMap.has(artist.id),
      composerId: composerMap.get(artist.id)?.id,
    })),
    album: {
      id: trackData.album.id,
      name: trackData.album.name,
      uri: trackData.album.uri,
      release_date: trackData.album.release_date,
      popularity: trackData.album.popularity,
      images: trackData.album.images,
      inSpotifyAlbumsTable: albumMap.has(trackData.album.id),
    },
    dbData: {
      track: trackMap.get(trackData.id) || null,
      album: albumMap.get(trackData.album.id) || null,
      artists: existingSpotifyArtists.filter((a) =>
        trackData.artists.some((ta) => ta.id === a.spotifyId)
      ),
      composers: composersData.filter((c) =>
        trackMovementsData.some((tm) => {
          const mvmt = movementsData.find((m) => m.id === tm.movementId);
          const wrk = mvmt && worksData.find((w) => w.id === mvmt.workId);
          return wrk && wrk.composerId === c.id && tm.spotifyTrackId === trackData.id;
        })
      ),
      trackMovements: trackMovementsData.filter((tm) => tm.spotifyTrackId === trackData.id),
      movements: movementsData.filter((m) =>
        trackMovementsData.some((tm) => tm.movementId === m.id && tm.spotifyTrackId === trackData.id)
      ),
      works: worksData.filter((w) =>
        movementsData.some((m) => {
          const tm = trackMovementsData.find((t) => t.movementId === m.id && t.spotifyTrackId === trackData.id);
          return tm && m.workId === w.id;
        })
      ),
      recordings: recordingsData.filter((r) =>
        worksData.some((w) => {
          const mvmt = movementsData.find((m) => m.workId === w.id);
          const tm = mvmt && trackMovementsData.find((t) => t.movementId === mvmt.id && t.spotifyTrackId === trackData.id);
          return tm && r.workId === w.id;
        })
      ),
    },
  }));
}

export async function getTrackMetadata(trackUri: string) {
  const session = await checkAuth();

  if (!trackUri || typeof trackUri !== "string") {
    throw new Error("Invalid track URI");
  }

  // Extract track ID from URI (spotify:track:TRACK_ID) or URL (https://open.spotify.com/track/TRACK_ID)
  let trackId: string | null = null;

  // Try URI format first
  const uriMatch = trackUri.match(/spotify:track:([a-zA-Z0-9]+)/);
  if (uriMatch) {
    trackId = uriMatch[1];
  } else {
    // Try URL format
    const urlMatch = trackUri.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
    if (urlMatch) {
      trackId = urlMatch[1];
    }
  }

  if (!trackId) {
    throw new Error("Invalid Spotify track URI or URL format");
  }

  // Get Spotify access token
  const accessToken = await getSpotifyAccessToken(session.user.id);
  const spotify = createServerSpotifyClient(accessToken);

  // Fetch track metadata from Spotify API
  try {
    const trackData = await spotify.tracks.get(trackId);

    // Check if artists, album, and track exist in database
    const artistIds = trackData.artists.map((a) => a.id);

    const [existingSpotifyArtists, existingComposers, existingAlbum, existingTrack] = await Promise.all([
      db
        .select()
        .from(spotifyArtist)
        .where(inArray(spotifyArtist.spotifyId, artistIds)),
      db
        .select()
        .from(composer)
        .where(inArray(composer.spotifyArtistId, artistIds)),
      db
        .select()
        .from(spotifyAlbum)
        .where(eq(spotifyAlbum.spotifyId, trackData.album.id)),
      db
        .select()
        .from(spotifyTrack)
        .where(eq(spotifyTrack.spotifyId, trackData.id)),
    ]);

    const spotifyArtistMap = new Map(
      existingSpotifyArtists.map((a) => [a.spotifyId, a])
    );
    const composerMap = new Map(
      existingComposers.map((c) => [c.spotifyArtistId, c])
    );

    // Fetch track movements and related data if track exists
    let trackMovementsData: TrackMovementRow[] = [];
    let movementsData: MovementRow[] = [];
    let worksData: WorkRow[] = [];
    let composersData: ComposerRow[] = [];
    let recordingsData: RecordingRow[] = [];

    if (existingTrack.length > 0) {
      const trackMovementRecords = await db
        .select()
        .from(trackMovement)
        .where(eq(trackMovement.spotifyTrackId, trackData.id));

      if (trackMovementRecords.length > 0) {
        trackMovementsData = trackMovementRecords;

        const movementIds = trackMovementRecords.map((tm) => tm.movementId);
        movementsData = await db
          .select()
          .from(movement)
          .where(inArray(movement.id, movementIds));

        const workIds = movementsData.map((m) => m.workId);
        if (workIds.length > 0) {
          worksData = await db
            .select()
            .from(work)
            .where(inArray(work.id, workIds));

          const composerIds = worksData.map((w) => w.composerId);
          if (composerIds.length > 0) {
            composersData = await db
              .select()
              .from(composer)
              .where(inArray(composer.id, composerIds));
          }

          // Fetch recordings for these works and this album
          recordingsData = await db
            .select()
            .from(recording)
            .where(
              inArray(recording.workId, workIds)
            );
        }
      }
    }

    const result: TrackMetadata = {
      id: trackData.id,
      name: trackData.name,
      uri: trackData.uri,
      duration_ms: trackData.duration_ms,
      disc_number: trackData.disc_number,
      track_number: trackData.track_number,
      popularity: trackData.popularity,
      inSpotifyTracksTable: existingTrack.length > 0,
      artists: trackData.artists.map((artist) => ({
        id: artist.id,
        name: artist.name,
        uri: artist.uri,
        inSpotifyArtistsTable: spotifyArtistMap.has(artist.id),
        inComposersTable: composerMap.has(artist.id),
        composerId: composerMap.get(artist.id)?.id,
      })),
      album: {
        id: trackData.album.id,
        name: trackData.album.name,
        uri: trackData.album.uri,
        release_date: trackData.album.release_date,
        popularity: trackData.album.popularity,
        images: trackData.album.images,
        inSpotifyAlbumsTable: existingAlbum.length > 0,
      },
      dbData: {
        track: existingTrack[0] || null,
        album: existingAlbum[0] || null,
        artists: existingSpotifyArtists,
        composers: composersData,
        trackMovements: trackMovementsData,
        movements: movementsData,
        works: worksData,
        recordings: recordingsData,
      },
    };
    return result;
  } catch (error) {
    console.error("Error fetching track metadata:", error);
    throw new Error("Failed to fetch track metadata");
  }
}
