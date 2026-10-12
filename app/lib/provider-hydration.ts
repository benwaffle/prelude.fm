import type { Track } from '@spotify/web-api-ts-sdk';
import { db, type DatabaseExecutor } from './db';
import { spotifyAlbum, spotifyArtist, spotifyTrack, trackArtists } from './db/schema';
import { normalizeIsrc } from './isrc';
import type { SpotifyAlbumMetadata } from './spotify-app-client';

/** Provider facts only; no classical table is touched here. */
export type ProviderHydration = {
  tracks: number;
  artists: number;
};

export async function hydrateProviderAlbum(
  album: SpotifyAlbumMetadata,
  tracks: Track[],
  database: DatabaseExecutor = db,
): Promise<ProviderHydration> {
  const year = album.release_date ? Number.parseInt(album.release_date.split('-')[0]) : null;
  // Only written when Spotify gave one, so a payload without it can't erase a stored total.
  const total = album.total_tracks != null ? { spotifyTrackTotal: album.total_tracks } : {};
  await database
    .insert(spotifyAlbum)
    .values({
      spotifyId: album.id,
      title: album.name,
      year: Number.isFinite(year) ? year : null,
      images: album.images,
      popularity: album.popularity ?? null,
      ...total,
    })
    .onConflictDoUpdate({
      target: spotifyAlbum.spotifyId,
      set: {
        title: album.name,
        year: Number.isFinite(year) ? year : null,
        images: album.images,
        popularity: album.popularity ?? null,
        ...total,
      },
    });

  const artists = new Map<string, string>();
  for (const track of tracks) {
    for (const artist of track.artists ?? []) artists.set(artist.id, artist.name);
  }
  for (const [spotifyId, name] of artists) {
    await database
      .insert(spotifyArtist)
      .values({ spotifyId, name, popularity: null, images: null })
      .onConflictDoNothing();
  }

  for (const track of tracks) {
    // Only write the ISRC when Spotify gave one, so a payload that omits it cannot erase a stored
    // value.
    const spotifyIsrc = normalizeIsrc(track.external_ids?.isrc);
    const isrc = spotifyIsrc ? { isrc: spotifyIsrc } : {};
    const values = {
      spotifyId: track.id,
      title: track.name,
      trackNumber: track.track_number,
      discNumber: track.disc_number,
      durationMs: track.duration_ms,
      popularity: track.popularity ?? null,
      spotifyAlbumId: album.id,
      ...isrc,
    };
    await database
      .insert(spotifyTrack)
      .values(values)
      .onConflictDoUpdate({ target: spotifyTrack.spotifyId, set: values });

    for (const artist of track.artists ?? []) {
      await database
        .insert(trackArtists)
        .values({ spotifyTrackId: track.id, spotifyArtistId: artist.id })
        .onConflictDoNothing();
    }
  }

  return { tracks: tracks.length, artists: artists.size };
}
