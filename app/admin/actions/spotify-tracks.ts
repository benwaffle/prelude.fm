'use server';

import { db } from '@/lib/db';
import { composer, spotifyAlbum, spotifyArtist, spotifyTrack } from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { Image as SpotifyImage, Track as SpotifyTrack } from '@spotify/web-api-ts-sdk';
import { checkAuth, getSpotifyClient } from './auth';
import { buildTrackMetadataDbData, loadTrackDbContext } from './spotify-utils';
import type {
  ComposerRow,
  SpotifyAlbumRow,
  SpotifyArtistRow,
  SpotifyTrackRow,
  TrackMovementRow,
  MovementRow,
  WorkRow,
  RecordingRow,
} from './schema-types';

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

export async function getAlbumTrackIds(albumId: string): Promise<string[]> {
  const spotify = await getSpotifyClient();

  const trackIds: string[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const albumTracks = await spotify.albums.tracks(albumId, undefined, limit, offset);
    trackIds.push(...albumTracks.items.map((t) => t.id));

    if (albumTracks.next === null) break;
    offset += limit;
  }

  return trackIds;
}

export async function getBatchTrackMetadata(trackUris: string[]) {
  await checkAuth();

  const trackIds: string[] = [];
  for (const trackUri of trackUris) {
    const uriMatch = trackUri.match(/spotify:track:([a-zA-Z0-9]+)/);
    const urlMatch = trackUri.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
    const trackId = uriMatch?.[1] ?? urlMatch?.[1] ?? null;
    if (trackId) {
      trackIds.push(trackId);
    }
  }

  if (trackIds.length === 0) {
    throw new Error('No valid track URIs found');
  }

  const spotify = await getSpotifyClient();

  const batchSize = 50;
  const allTrackData: SpotifyTrack[] = [];

  for (let i = 0; i < trackIds.length; i += batchSize) {
    const batchIds = trackIds.slice(i, i + batchSize);
    const tracks = await spotify.tracks.get(batchIds);
    allTrackData.push(...tracks);
  }

  const artistIds = [...new Set(allTrackData.flatMap((track) => track.artists.map((a) => a.id)))];
  const albumIds = [...new Set(allTrackData.map((track) => track.album.id))];

  const [existingSpotifyArtists, existingComposers, existingAlbums, existingTracks] =
    await Promise.all([
      artistIds.length > 0
        ? db.select().from(spotifyArtist).where(inArray(spotifyArtist.spotifyId, artistIds))
        : [],
      artistIds.length > 0
        ? db.select().from(composer).where(inArray(composer.spotifyArtistId, artistIds))
        : [],
      albumIds.length > 0
        ? db.select().from(spotifyAlbum).where(inArray(spotifyAlbum.spotifyId, albumIds))
        : [],
      trackIds.length > 0
        ? db.select().from(spotifyTrack).where(inArray(spotifyTrack.spotifyId, trackIds))
        : [],
    ]);

  const spotifyArtistMap = new Map(existingSpotifyArtists.map((a) => [a.spotifyId, a]));
  const composerMap = new Map(existingComposers.map((c) => [c.spotifyArtistId, c]));
  const albumMap = new Map(existingAlbums.map((a) => [a.spotifyId, a]));
  const trackMap = new Map(existingTracks.map((t) => [t.spotifyId, t]));

  const existingTrackIds = existingTracks.map((t) => t.spotifyId);
  const { trackMovementsData, movementsData, worksData, composersData, recordingsData } =
    await loadTrackDbContext(existingTrackIds);

  return allTrackData.map(
    (trackData): TrackMetadata => ({
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
      dbData: buildTrackMetadataDbData({
        trackId: trackData.id,
        artists: trackData.artists,
        existingSpotifyArtists,
        trackMovementsData,
        movementsData,
        worksData,
        composersData,
        recordingsData,
        trackRow: trackMap.get(trackData.id) || null,
        albumRow: albumMap.get(trackData.album.id) || null,
      }),
    }),
  );
}

export async function getTrackMetadata(trackUri: string) {
  await checkAuth();

  if (!trackUri || typeof trackUri !== 'string') {
    throw new Error('Invalid track URI');
  }

  const uriMatch = trackUri.match(/spotify:track:([a-zA-Z0-9]+)/);
  const urlMatch = trackUri.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
  const trackId = uriMatch?.[1] ?? urlMatch?.[1] ?? null;

  if (!trackId) {
    throw new Error('Invalid Spotify track URI or URL format');
  }

  const spotify = await getSpotifyClient();

  try {
    const trackData = await spotify.tracks.get(trackId);

    const artistIds = trackData.artists.map((a) => a.id);

    const [existingSpotifyArtists, existingComposers, existingAlbum, existingTrack] =
      await Promise.all([
        db.select().from(spotifyArtist).where(inArray(spotifyArtist.spotifyId, artistIds)),
        db.select().from(composer).where(inArray(composer.spotifyArtistId, artistIds)),
        db.select().from(spotifyAlbum).where(eq(spotifyAlbum.spotifyId, trackData.album.id)),
        db.select().from(spotifyTrack).where(eq(spotifyTrack.spotifyId, trackData.id)),
      ]);

    const spotifyArtistMap = new Map(existingSpotifyArtists.map((a) => [a.spotifyId, a]));
    const composerMap = new Map(existingComposers.map((c) => [c.spotifyArtistId, c]));

    const { trackMovementsData, movementsData, worksData, composersData, recordingsData } =
      existingTrack.length > 0
        ? await loadTrackDbContext([trackData.id])
        : {
            trackMovementsData: [],
            movementsData: [],
            worksData: [],
            composersData: [],
            recordingsData: [],
          };

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
      dbData: buildTrackMetadataDbData({
        trackId: trackData.id,
        artists: trackData.artists,
        existingSpotifyArtists,
        trackMovementsData,
        movementsData,
        worksData,
        composersData,
        recordingsData,
        trackRow: existingTrack[0] || null,
        albumRow: existingAlbum[0] || null,
      }),
    };
    return result;
  } catch (error) {
    console.error('Error fetching track metadata:', error);
    throw new Error('Failed to fetch track metadata');
  }
}
