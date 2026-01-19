"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { trackMovement, matchQueue, movement, work, composer, spotifyArtist } from "@/lib/db/schema";
import { headers } from "next/headers";
import { inArray, eq, sql } from "drizzle-orm";

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

export async function submitToMatchQueue(trackIds: string[]): Promise<{ submitted: number }> {
  if (trackIds.length === 0) return { submitted: 0 };

  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error("Unauthorized");
  }

  // Filter out tracks already in queue
  const existing = await db
    .select({ spotifyId: matchQueue.spotifyId })
    .from(matchQueue)
    .where(inArray(matchQueue.spotifyId, trackIds));

  const existingIds = new Set(existing.map((e) => e.spotifyId));
  const newTrackIds = trackIds.filter((id) => !existingIds.has(id));

  if (newTrackIds.length === 0) return { submitted: 0 };

  await db.insert(matchQueue).values(
    newTrackIds.map((id) => ({
      spotifyId: id,
      submittedBy: session.user.id,
      status: "pending",
    }))
  );

  return { submitted: newTrackIds.length };
}

export async function getQueuedTrackIds(trackIds: string[]): Promise<string[]> {
  if (trackIds.length === 0) return [];

  const results = await db
    .select({ spotifyId: matchQueue.spotifyId })
    .from(matchQueue)
    .where(inArray(matchQueue.spotifyId, trackIds));

  return results.map((r) => r.spotifyId);
}

export async function getMatchQueue(
  limit = 50,
  offset = 0
): Promise<{ items: { spotifyId: string; submittedAt: Date; status: string }[]; total: number }> {
  const [countResult, results] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(matchQueue).where(eq(matchQueue.status, "pending")),
    db
      .select()
      .from(matchQueue)
      .where(eq(matchQueue.status, "pending"))
      .orderBy(matchQueue.submittedAt)
      .limit(limit)
      .offset(offset),
  ]);

  return {
    items: results.map((r) => ({
      spotifyId: r.spotifyId,
      submittedAt: r.submittedAt,
      status: r.status,
    })),
    total: countResult[0]?.count ?? 0,
  };
}

export async function updateMatchQueueStatus(trackIds: string[], status: "matched" | "failed"): Promise<void> {
  if (trackIds.length === 0) return;

  await db
    .update(matchQueue)
    .set({ status })
    .where(inArray(matchQueue.spotifyId, trackIds));
}

export interface KnownComposerTrack {
  artistId: string;
  composerName: string;
}

export async function getKnownComposerArtists(artistIds: string[]): Promise<KnownComposerTrack[]> {
  if (artistIds.length === 0) return [];

  const results = await db
    .select({
      artistId: spotifyArtist.spotifyId,
      composerName: composer.name,
    })
    .from(composer)
    .innerJoin(spotifyArtist, eq(composer.spotifyArtistId, spotifyArtist.spotifyId))
    .where(inArray(spotifyArtist.spotifyId, artistIds));

  return results;
}
