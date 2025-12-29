"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { trackMovement } from "@/lib/db/schema";
import { headers } from "next/headers";
import { inArray, eq } from "drizzle-orm";

export async function getSpotifyToken(): Promise<string> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error("Unauthorized");
  }

  const tokenResponse = await auth.api.getAccessToken({
    body: {
      providerId: "spotify",
      userId: session.user.id,
    },
    headers: await headers(),
  });

  if (!tokenResponse?.accessToken) {
    throw new Error("No Spotify access token");
  }

  return tokenResponse.accessToken;
}

export interface MatchedTrack {
  trackId: string;
  movementNumber: number;
  movementName: string | null;
  work: {
    id: number;
    title: string;
    catalogSystem: string | null;
    catalogNumber: string | null;
    nickname: string | null;
    composerName: string;
  };
}

export async function getMatchedTracks(trackIds: string[]): Promise<MatchedTrack[]> {
  if (trackIds.length === 0) return [];

  const { movement, work, composer } = await import("@/lib/db/schema");

  const results = await db
    .select({
      trackId: trackMovement.spotifyTrackId,
      movementNumber: movement.number,
      movementName: movement.title,
      workId: work.id,
      workTitle: work.title,
      catalogSystem: work.catalogSystem,
      catalogNumber: work.catalogNumber,
      nickname: work.nickname,
      composerName: composer.name,
    })
    .from(trackMovement)
    .innerJoin(movement, eq(trackMovement.movementId, movement.id))
    .innerJoin(work, eq(movement.workId, work.id))
    .innerJoin(composer, eq(work.composerId, composer.id))
    .where(inArray(trackMovement.spotifyTrackId, trackIds));

  return results.map((r) => ({
    trackId: r.trackId,
    movementNumber: r.movementNumber,
    movementName: r.movementName,
    work: {
      id: r.workId,
      title: r.workTitle,
      catalogSystem: r.catalogSystem,
      catalogNumber: r.catalogNumber,
      nickname: r.nickname,
      composerName: r.composerName,
    },
  }));
}
