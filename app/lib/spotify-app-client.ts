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
}

export interface SpotifyArtistMetadata {
  id: string;
  name: string;
}

interface SpotifyAlbumResponse extends SpotifyAlbumMetadata {
  tracks: SpotifyAlbumTrackPage;
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;
const artistSearchCache = new Map<string, Promise<SpotifyArtistMetadata | null>>();
let spotifyBlockedUntil = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeArtistName(name: string) {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Pd}/gu, '-')
    .trim()
    .toLocaleLowerCase();
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
    const waitMs = spotifyBlockedUntil - Date.now();
    if (waitMs > 0) await sleep(waitMs);

    const accessToken = await getSpotifyAppAccessToken();
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

/** Albums in batches, keeping `external_ids` so the barcode survives. */
export async function getSpotifyAlbumsByIds(albumIds: string[]) {
  const albums: Array<{ id: string; name: string; external_ids?: { upc?: string } }> = [];
  for (let i = 0; i < albumIds.length; i += 20) {
    const batch = albumIds.slice(i, i + 20);
    const result = await spotifyFetch<{
      albums: Array<{ id: string; name: string; external_ids?: { upc?: string } } | null>;
    }>(`/albums?ids=${batch.join(',')}`);
    for (const album of result.albums) if (album) albums.push(album);
  }
  return albums;
}

export async function getSpotifyAlbumMetadata(albumId: string): Promise<SpotifyAlbumMetadata> {
  const album = await spotifyFetch<SpotifyAlbumResponse>(`/albums/${albumId}`);
  return {
    id: album.id,
    name: album.name,
    uri: album.uri,
    release_date: album.release_date,
    popularity: album.popularity ?? null,
    images: album.images,
  };
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

export async function findSpotifyArtistByName(name: string) {
  const normalizedName = normalizeArtistName(name);
  const cached = artistSearchCache.get(normalizedName);
  if (cached) return cached;

  const request = spotifyFetch<{
    artists: { items: Array<SpotifyArtistMetadata & { popularity?: number }> };
  }>(`/search?type=artist&limit=10&q=${encodeURIComponent(`artist:${name}`)}`).then(
    ({ artists }) =>
      artists.items
        .filter((artist) => normalizeArtistName(artist.name) === normalizedName)
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0] ?? null,
  );

  artistSearchCache.set(normalizedName, request);
  return request;
}
