import type { Track } from '@spotify/web-api-ts-sdk';

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface SpotifyAlbumTrackPage {
  items: Array<{ id: string }>;
  next: string | null;
  total: number;
}

export interface SpotifyAlbumMetadata {
  id: string;
  name: string;
  uri: string;
  release_date: string;
  popularity: number | null;
  images: { url: string; width: number; height: number }[];
  total_tracks?: number;
  /** The barcode, which is how MusicBrainz indexes releases. */
  upc?: string | null;
}

export interface SpotifyArtistMetadata {
  id: string;
  name: string;
}

interface SpotifyAlbumResponse extends Omit<SpotifyAlbumMetadata, 'upc'> {
  tracks: SpotifyAlbumTrackPage;
  external_ids?: { upc?: string };
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;
let spotifyBlockedUntil = 0;

// A bulk run keeps a steady pace instead of bursting into Spotify's rolling-window limit; the app
// itself sends too few requests to need one.
let minIntervalMs = 0;
let nextRequestAt = 0;
let requestsSent = 0;

export function setSpotifyRequestInterval(ms: number) {
  minIntervalMs = Math.max(0, ms);
}

/** Every request sent to the Web API in this process, retries included. */
export function spotifyRequestsSent() {
  return requestsSent;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSpotifyAppAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Spotify app token: ${response.status}`);
  }

  const token = (await response.json()) as SpotifyTokenResponse;
  cachedToken = {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
  };

  return cachedToken.accessToken;
}

async function spotifyFetch<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const waitMs = Math.max(spotifyBlockedUntil, nextRequestAt) - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    nextRequestAt = Date.now() + minIntervalMs;

    const accessToken = await getSpotifyAppAccessToken();
    requestsSent++;
    const response = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.ok) return response.json() as Promise<T>;

    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get('retry-after') ?? 5);
      if (retryAfterSeconds > 60) {
        throw new Error(`Spotify rate limit retry after ${retryAfterSeconds} seconds for ${path}`);
      }
      const retryAfterMs = Math.max(1, retryAfterSeconds) * 1_000;
      spotifyBlockedUntil = Math.max(spotifyBlockedUntil, Date.now() + retryAfterMs);
      if (attempt < 3) continue;
    } else if (response.status >= 500 && attempt < 3) {
      await sleep(1_000 * 2 ** attempt);
      continue;
    }

    throw new Error(`Spotify API request failed (${response.status}) for ${path}`);
  }
  throw new Error(`Spotify API request retries exhausted for ${path}`);
}

export async function getSpotifyTracksByIds(trackIds: string[]) {
  const tracks: Track[] = [];
  const batchSize = 50;

  for (let i = 0; i < trackIds.length; i += batchSize) {
    const batch = trackIds.slice(i, i + batchSize);
    const result = await spotifyFetch<{ tracks: Array<Track | null> }>(
      `/tracks?ids=${batch.join(',')}`,
    );
    tracks.push(...result.tracks.filter((track): track is Track => track !== null));
  }

  return tracks;
}

function albumMetadataOf(album: SpotifyAlbumResponse): SpotifyAlbumMetadata {
  return {
    id: album.id,
    name: album.name,
    uri: album.uri,
    release_date: album.release_date,
    popularity: album.popularity ?? null,
    images: album.images,
    total_tracks: album.total_tracks,
    upc: album.external_ids?.upc?.trim() || null,
  };
}

export async function getSpotifyAlbumMetadata(albumId: string): Promise<SpotifyAlbumMetadata> {
  return albumMetadataOf(await spotifyFetch<SpotifyAlbumResponse>(`/albums/${albumId}`));
}

export type SpotifyAlbumWithTrackIds = SpotifyAlbumMetadata & {
  /** The first page of the album's tracks. */
  trackIds: string[];
  /** The album has more tracks than the first page holds. */
  moreTracks: boolean;
};

/** Twenty albums a request. Null where Spotify has no album with that ID. */
export async function getSpotifyAlbumsByIds(
  albumIds: string[],
): Promise<(SpotifyAlbumWithTrackIds | null)[]> {
  const albums: (SpotifyAlbumWithTrackIds | null)[] = [];
  for (let i = 0; i < albumIds.length; i += 20) {
    const batch = albumIds.slice(i, i + 20);
    const result = await spotifyFetch<{ albums: (SpotifyAlbumResponse | null)[] }>(
      `/albums?ids=${batch.join(',')}`,
    );
    for (const index of batch.keys()) {
      const found = result.albums[index];
      albums.push(
        found
          ? {
              ...albumMetadataOf(found),
              trackIds: found.tracks.items.map((track) => track.id).filter(Boolean),
              moreTracks: found.tracks.next !== null,
            }
          : null,
      );
    }
  }
  return albums;
}

/** Tracks Spotify files under this ISRC; the search is fuzzy, so the caller checks the ISRC. */
export async function searchSpotifyTracksByIsrc(isrc: string): Promise<Track[]> {
  const result = await spotifyFetch<{ tracks?: { items: (Track | null)[] } }>(
    `/search?type=track&limit=10&q=${encodeURIComponent(`isrc:${isrc}`)}`,
  );
  return (result.tracks?.items ?? []).filter((track): track is Track => track !== null);
}

export async function getSpotifyAlbumTrackIds(albumId: string) {
  const trackIds: string[] = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const page = await spotifyFetch<SpotifyAlbumTrackPage>(
      `/albums/${albumId}/tracks?limit=${limit}&offset=${offset}`,
    );
    trackIds.push(...page.items.map((track) => track.id).filter(Boolean));

    if (page.next === null) break;
    offset += limit;
  }

  return trackIds;
}

export async function getSpotifyAlbumTracks(albumId: string) {
  const [album, trackIds] = await Promise.all([
    getSpotifyAlbumMetadata(albumId),
    getSpotifyAlbumTrackIds(albumId),
  ]);
  const tracks = await getSpotifyTracksByIds(trackIds);
  return { album, tracks };
}

/** Artists in credit order, as Harmony reads them. */
export async function getSpotifyAlbumSeed(albumId: string) {
  const album = await spotifyFetch<{
    id: string;
    name: string;
    artists: SpotifyArtistMetadata[];
    external_ids?: { upc?: string };
    release_date?: string;
    label?: string;
  }>(`/albums/${albumId}`);
  const tracks = await getSpotifyTracksByIds(await getSpotifyAlbumTrackIds(albumId));
  return { album, tracks };
}
