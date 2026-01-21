'use server';

import { db } from '@/lib/db';
import { composer, spotifyArtist } from '@/lib/db/schema';
import { or, isNull, eq, sql, inArray } from 'drizzle-orm';
import { checkAuth, getSpotifyClient } from './auth';

export interface SpotifyArtistSearchResult {
  id: string;
  name: string;
  popularity: number;
  images: { url: string; width: number; height: number }[];
  genres: string[];
}

export async function searchSpotifyArtists(
  query: string,
  limit: 1 | 2 | 3 | 4 | 5 | 10 | 20 | 50 = 5,
): Promise<SpotifyArtistSearchResult[]> {
  await checkAuth();
  const spotify = await getSpotifyClient();

  const results = await spotify.search(query, ['artist'], undefined, limit);

  return results.artists.items.map((artist) => ({
    id: artist.id,
    name: artist.name,
    popularity: artist.popularity,
    images: artist.images,
    genres: artist.genres,
  }));
}

export async function searchSpotifyArtistForImport(input: {
  name: string;
  birthYear?: number;
  deathYear?: number;
}): Promise<{
  input: { name: string; birthYear?: number; deathYear?: number };
  results: SpotifyArtistSearchResult[];
  existingComposerId?: number;
}> {
  await checkAuth();
  const spotify = await getSpotifyClient();

  const [existingComposer] = await db
    .select({ id: composer.id })
    .from(composer)
    .where(sql`lower(${composer.name}) = ${input.name.toLowerCase()}`)
    .limit(1);

  if (existingComposer?.id) {
    return {
      input,
      results: [],
      existingComposerId: existingComposer.id,
    };
  }

  try {
    const searchResults = await spotify.search(input.name, ['artist'], undefined, 3);
    return {
      input,
      results: searchResults.artists.items.map((artist) => ({
        id: artist.id,
        name: artist.name,
        popularity: artist.popularity,
        images: artist.images,
        genres: artist.genres,
      })),
      existingComposerId: existingComposer?.id,
    };
  } catch (err) {
    console.error(`Failed to search for ${input.name}:`, err);
    return {
      input,
      results: [],
      existingComposerId: undefined,
    };
  }
}

export async function refreshSpotifyArtistMetadataMissing(): Promise<{
  updated: number;
  total: number;
}> {
  await checkAuth();
  const spotify = await getSpotifyClient();

  const artistsToRefresh = await db
    .select({ spotifyId: spotifyArtist.spotifyId })
    .from(spotifyArtist)
    .where(or(isNull(spotifyArtist.popularity), isNull(spotifyArtist.images)));

  const ids = artistsToRefresh.map((a) => a.spotifyId);
  const batchSize = 50;
  let updated = 0;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    if (batch.length === 0) {
      continue;
    }

    try {
      const artists = await spotify.artists.get(batch);
      await Promise.all(
        artists.map((artist) =>
          db
            .update(spotifyArtist)
            .set({
              name: artist.name,
              popularity: artist.popularity ?? null,
              images: artist.images ?? null,
            })
            .where(eq(spotifyArtist.spotifyId, artist.id)),
        ),
      );
      updated += artists.length;
    } catch (err) {
      console.error('Failed to refresh Spotify artist metadata batch:', err);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return { updated, total: ids.length };
}

export interface SpotifyPlaylistSearchResult {
  id: string;
  name: string;
  description: string | null;
  owner: string;
  images: { url: string; width: number | null; height: number | null }[];
  trackCount: number;
}

function getPlaylistTrackCount(playlist: unknown) {
  const maybeTracks = (playlist as { tracks?: { total?: number } | null }).tracks;
  return typeof maybeTracks?.total === 'number' ? maybeTracks.total : 0;
}

export async function searchSpotifyPlaylists(
  query: string,
  limit: 10 | 20 | 50 = 20,
): Promise<SpotifyPlaylistSearchResult[]> {
  await checkAuth();
  const spotify = await getSpotifyClient();

  const results = await spotify.search(query, ['playlist'], undefined, limit);

  return results.playlists.items.map((playlist) => ({
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    owner: playlist.owner.display_name || playlist.owner.id,
    images: playlist.images,
    trackCount: getPlaylistTrackCount(playlist),
  }));
}

export interface PlaylistArtistInfo {
  id: string;
  name: string;
  trackCount: number;
  sampleTrack: string;
  existingComposerId?: number;
}

export async function getPlaylistArtists(playlistId: string): Promise<PlaylistArtistInfo[]> {
  await checkAuth();
  const spotify = await getSpotifyClient();

  const artistCounts = new Map<string, { name: string; count: number; sampleTrack: string }>();
  let offset = 0;
  const limit = 50;

  while (true) {
    const page = await spotify.playlists.getPlaylistItems(
      playlistId,
      undefined,
      undefined,
      limit,
      offset,
    );

    for (const item of page.items) {
      if (!item.track || item.track.type !== 'track') continue;

      const track = item.track as { artists?: Array<{ id: string; name: string }>; name: string };
      if (!track.artists) continue;

      for (const artist of track.artists) {
        const existing = artistCounts.get(artist.id);
        if (existing) {
          existing.count++;
        } else {
          artistCounts.set(artist.id, {
            name: artist.name,
            count: 1,
            sampleTrack: track.name,
          });
        }
      }
    }

    if (page.next === null || page.items.length < limit) break;
    offset += limit;
  }

  const artistIds = Array.from(artistCounts.keys());
  const existingComposers =
    artistIds.length > 0
      ? await db
          .select({ id: composer.id, spotifyArtistId: composer.spotifyArtistId })
          .from(composer)
          .where(inArray(composer.spotifyArtistId, artistIds))
      : [];

  const composerByArtistId = new Map(existingComposers.map((c) => [c.spotifyArtistId, c.id]));

  const result: PlaylistArtistInfo[] = Array.from(artistCounts.entries())
    .map(([id, info]) => ({
      id,
      name: info.name,
      trackCount: info.count,
      sampleTrack: info.sampleTrack,
      existingComposerId: composerByArtistId.get(id),
    }))
    .sort((a, b) => b.trackCount - a.trackCount);

  return result;
}
