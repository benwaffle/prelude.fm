import type { Track } from '@spotify/web-api-ts-sdk';
import { db, type DatabaseExecutor } from './db';
import { spotifyAlbum, spotifyArtist, spotifyTrack, trackArtists } from './db/schema';
import type { SpotifyAlbumMetadata } from './spotify-app-client';

/**
 * Writing down what Spotify said, and nothing else.
 *
 * Provider facts — the album, its tracks, their artists, durations, ISRCs —
 * are global and uncontroversial: they are what Spotify is for. They get
 * their own pass so that reading an album into the cache no longer requires
 * deciding anything about the music on it. The previous route into these
 * tables ran through the metadata save, which meant the only way to record
 * that a track exists was to also assert a composer and a work for it.
 *
 * No classical table is touched here. That is the point.
 */
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
  await database
    .insert(spotifyAlbum)
    .values({
      spotifyId: album.id,
      title: album.name,
      year: Number.isFinite(year) ? year : null,
      images: album.images,
      popularity: album.popularity ?? null,
    })
    .onConflictDoUpdate({
      target: spotifyAlbum.spotifyId,
      set: {
        title: album.name,
        year: Number.isFinite(year) ? year : null,
        images: album.images,
        popularity: album.popularity ?? null,
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
    // Only write the ISRC when Spotify gave us one, so a payload that omits
    // it cannot erase a value an earlier read stored.
    const isrc = track.external_ids?.isrc ? { isrc: track.external_ids.isrc } : {};
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
