import type { Track } from '@spotify/web-api-ts-sdk';

/**
 * The parts of Spotify's Web API the player uses, and what its answers mean
 * to a listener. The player endpoints answer most commands with an empty
 * 204, which the typed SDK tries to parse as JSON, so these go through fetch
 * directly.
 */

/** Somewhere Spotify can play: this browser, or a Spotify Connect device. */
export interface PlaybackDevice {
  id: string;
  name: string;
  /** Spotify's device type: Computer, Smartphone, Speaker, … */
  type: string;
  /** The browser tab's own Web Playback SDK player. */
  isThisBrowser: boolean;
  /** Spotify refuses remote control of restricted devices. */
  isRestricted: boolean;
  supportsVolume: boolean;
}

export interface SpotifyApiDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  supports_volume?: boolean;
  volume_percent: number | null;
}

export interface SpotifyApiPlaybackState {
  device: SpotifyApiDevice;
  progress_ms: number | null;
  is_playing: boolean;
  item: (Track & { type: 'track' }) | { type: 'episode' } | null;
}

export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function spotifyApi(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let reason = res.statusText;
    try {
      const json = await res.json();
      reason = json?.error?.message ?? reason;
    } catch {
      // Not every error carries a body.
    }
    throw new SpotifyApiError(res.status, reason);
  }
  return res;
}

/** What the account is playing, and where; null when nothing is loaded anywhere. */
export async function readPlaybackState(token: string): Promise<SpotifyApiPlaybackState | null> {
  const res = await spotifyApi(token, '/me/player');
  if (res.status === 204) return null;
  return (await res.json()) as SpotifyApiPlaybackState;
}

export async function listDevices(token: string): Promise<SpotifyApiDevice[]> {
  const res = await spotifyApi(token, '/me/player/devices');
  return ((await res.json()) as { devices: SpotifyApiDevice[] }).devices;
}

/** Spotify's refusals, said the way a listener would want to hear them. */
export function describeFailure(err: unknown, device: PlaybackDevice | null): string {
  if (err instanceof SpotifyApiError) {
    if (err.status === 404) {
      return device && !device.isThisBrowser
        ? `Spotify can’t reach ${device.name}. Open Spotify on it, then choose it again.`
        : 'Spotify can’t find a device to play on.';
    }
    if (err.status === 403) return `Spotify refused: ${err.message}`;
    if (err.status === 401) return 'Spotify’s sign-in expired. Reload to sign in again.';
    return `Spotify returned an error: ${err.message}`;
  }
  return err instanceof Error ? err.message : 'Spotify didn’t respond.';
}

export function toDevice(d: SpotifyApiDevice, localId: string | null): PlaybackDevice | null {
  if (!d.id) return null;
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    isThisBrowser: d.id === localId,
    isRestricted: d.is_restricted,
    supportsVolume: d.supports_volume ?? d.volume_percent !== null,
  };
}

/** This tab's own player, as the device list shows it. */
export function localDevice(id: string): PlaybackDevice {
  return {
    id,
    name: 'This browser',
    type: 'Computer',
    isThisBrowser: true,
    isRestricted: false,
    supportsVolume: true,
  };
}
