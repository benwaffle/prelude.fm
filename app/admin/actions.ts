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
import { eq, and, inArray } from "drizzle-orm";

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

export async function addAlbumToDatabase(albumData: {
  id: string;
  name: string;
  release_date: string;
  popularity: number;
  images: { url: string; width: number; height: number }[];
}) {
  const session = await checkAuth();

  try {
    const accessToken = await getSpotifyAccessToken(session.user.id);

    const year = albumData.release_date
      ? parseInt(albumData.release_date.split("-")[0])
      : null;

    const albumResponse = await fetch(
      `https://api.spotify.com/v1/albums/${albumData.id}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const fullAlbumData = await albumResponse.json();

    await db
      .insert(spotifyAlbum)
      .values({
        spotifyId: albumData.id,
        title: albumData.name,
        year,
        images: albumData.images,
        popularity: fullAlbumData.popularity || null,
      })
      .onConflictDoUpdate({
        target: spotifyAlbum.spotifyId,
        set: {
          title: albumData.name,
          year,
          images: albumData.images,
          popularity: fullAlbumData.popularity || null,
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

export async function addArtistsToDatabase(artists: { id: string; name: string }[]) {
  const session = await checkAuth();

  try {
    const accessToken = await getSpotifyAccessToken(session.user.id);

    for (const artist of artists) {
      const artistResponse = await fetch(
        `https://api.spotify.com/v1/artists/${artist.id}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      const artistData = await artistResponse.json();

      await db
        .insert(spotifyArtist)
        .values({
          spotifyId: artist.id,
          name: artist.name,
          popularity: artistData.popularity || null,
          images: artistData.images || null,
        })
        .onConflictDoUpdate({
          target: spotifyArtist.spotifyId,
          set: {
            name: artist.name,
            popularity: artistData.popularity || null,
            images: artistData.images || null,
          },
        });
    }

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

    // Create a slug from the name
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim();

    await db.insert(composer).values({
      id,
      name,
      spotifyArtistId,
    });

    return {
      success: true,
      composer: {
        id,
        name,
        spotifyArtistId,
      },
    };
  } catch (error) {
    console.error("Error adding composer:", error);
    throw new Error("Failed to add composer");
  }
}

export async function checkWorkAndMovement(
  composerId: string,
  catalogSystem: string,
  catalogNumber: string,
  movementNumber: number
) {
  await checkAuth();

  try {
    // Find work by composer and catalog number
    const works = await db
      .select()
      .from(work)
      .where(
        and(
          eq(work.composerId, composerId),
          eq(work.catalogSystem, catalogSystem),
          eq(work.catalogNumber, catalogNumber)
        )
      );

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
  composerId: string;
  formalName: string;
  nickname: string | null;
  catalogSystem: string;
  catalogNumber: string;
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
    // Create work ID slug
    const workId = `${data.composerId}/${data.catalogSystem.toLowerCase()}-${data.catalogNumber}`;

    // Upsert work
    await db
      .insert(work)
      .values({
        id: workId,
        composerId: data.composerId,
        title: data.formalName,
        nickname: data.nickname,
        catalogSystem: data.catalogSystem,
        catalogNumber: data.catalogNumber,
        yearComposed: data.yearComposed,
        form: data.form,
      })
      .onConflictDoUpdate({
        target: work.id,
        set: {
          title: data.formalName,
          nickname: data.nickname,
          catalogSystem: data.catalogSystem,
          catalogNumber: data.catalogNumber,
          yearComposed: data.yearComposed,
          form: data.form,
        },
      });

    // Create movement ID
    const movementId = `${workId}/${data.movementNumber}`;

    // Upsert movement
    await db
      .insert(movement)
      .values({
        id: movementId,
        workId,
        number: data.movementNumber,
        title: data.movementName,
      })
      .onConflictDoUpdate({
        target: movement.id,
        set: {
          number: data.movementNumber,
          title: data.movementName,
        },
      });

    // Create recording ID
    const recordingId = `${data.spotifyAlbumId}/${workId}`;

    // Upsert recording (links album to work)
    await db
      .insert(recording)
      .values({
        id: recordingId,
        spotifyAlbumId: data.spotifyAlbumId,
        workId,
        popularity: null, // Will be calculated later by averaging tracks
      })
      .onConflictDoNothing();

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

  // Fetch track metadata from Spotify API
  try {
    const response = await fetch(
      `https://api.spotify.com/v1/tracks/${trackId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || "Failed to fetch track from Spotify");
    }

    const trackData = await response.json();

    // Check if artists, album, and track exist in database
    const artistIds = trackData.artists.map((a: any) => a.id);

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
    let trackMovements: any[] = [];
    let movementsData: any[] = [];
    let worksData: any[] = [];
    let composersData: any[] = [];
    let recordingsData: any[] = [];

    if (existingTrack.length > 0) {
      const trackMovementRecords = await db
        .select()
        .from(trackMovement)
        .where(eq(trackMovement.spotifyTrackId, trackData.id));

      if (trackMovementRecords.length > 0) {
        trackMovements = trackMovementRecords;

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

    return {
      id: trackData.id,
      name: trackData.name,
      uri: trackData.uri,
      duration_ms: trackData.duration_ms,
      track_number: trackData.track_number,
      popularity: trackData.popularity,
      inSpotifyTracksTable: existingTrack.length > 0,
      artists: trackData.artists.map((artist: any) => ({
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
        trackMovements: trackMovements,
        movements: movementsData,
        works: worksData,
        recordings: recordingsData,
      },
    };
  } catch (error) {
    console.error("Error fetching track metadata:", error);
    throw new Error("Failed to fetch track metadata");
  }
}
