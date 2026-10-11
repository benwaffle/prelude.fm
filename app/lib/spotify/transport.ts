import { spotifyApi, type PlaybackDevice } from './web-api';
import { positionAt, type ProgressStore } from './progress';

/**
 * The controls, for wherever playback is going. This browser's player is
 * driven through the Web Playback SDK; a Spotify Connect device through the
 * Web API. Starting playback goes through the Web API for both, since only
 * it can hand over a list of tracks.
 */
export interface PlaybackTransport {
  play(uris: string[], positionMs?: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  toggle(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  previous(): Promise<void>;
  next(): Promise<void>;
  setVolume(volume: number): Promise<void>;
}

/**
 * Send one request on behalf of `device`: on success clear the last refusal,
 * on failure say what Spotify refused, and either way re-read a Connect
 * device, which takes a moment to act.
 */
export type Send = (
  device: PlaybackDevice,
  what: string,
  request: (token: string) => Promise<unknown>,
) => Promise<void>;

function play(send: Send, device: PlaybackDevice, uris: string[], positionMs?: number) {
  return send(device, 'Starting playback', (token) =>
    spotifyApi(token, `/me/player/play?device_id=${encodeURIComponent(device.id)}`, {
      method: 'PUT',
      body: positionMs ? { uris, position_ms: Math.round(positionMs) } : { uris },
    }),
  );
}

/** This tab's player. */
export function localTransport(
  player: Spotify.Player | null,
  device: PlaybackDevice,
  send: Send,
): PlaybackTransport {
  return {
    play: (uris, positionMs) => play(send, device, uris, positionMs),
    pause: async () => player?.pause(),
    resume: async () => player?.resume(),
    toggle: async () => player?.togglePlay(),
    seek: async (positionMs) => player?.seek(positionMs),
    previous: async () => player?.previousTrack(),
    next: async () => player?.nextTrack(),
    setVolume: async (volume) => player?.setVolume(volume),
  };
}

/**
 * A Connect device, or nowhere yet (`device` null), where every command but
 * the optimistic bookkeeping is a no-op. Taps are answered at once in
 * `progress`; the next poll corrects them if Spotify disagrees.
 */
export function connectTransport(
  device: PlaybackDevice | null,
  send: Send,
  progress: ProgressStore,
  setPaused: (paused: boolean) => void,
): PlaybackTransport {
  const command = async (method: string, path: string) => {
    if (!device) return;
    const sep = path.includes('?') ? '&' : '?';
    await send(device, `Spotify ${method} ${path}`, (token) =>
      spotifyApi(token, `${path}${sep}device_id=${encodeURIComponent(device.id)}`, { method }),
    );
  };
  return {
    play: async (uris, positionMs) => {
      if (device) await play(send, device, uris, positionMs);
    },
    pause: () => command('PUT', '/me/player/pause'),
    resume: () => command('PUT', '/me/player/play'),
    toggle: () => {
      const now = progress.get();
      progress.set({
        ...now,
        position: positionAt(now, Date.now()),
        timestamp: Date.now(),
        paused: !now.paused,
      });
      setPaused(!now.paused);
      return command('PUT', now.paused ? '/me/player/play' : '/me/player/pause');
    },
    seek: (positionMs) => {
      progress.set({ ...progress.get(), position: positionMs, timestamp: Date.now() });
      return command('PUT', `/me/player/seek?position_ms=${Math.round(positionMs)}`);
    },
    previous: () => command('POST', '/me/player/previous'),
    next: () => command('POST', '/me/player/next'),
    setVolume: (volume) =>
      command('PUT', `/me/player/volume?volume_percent=${Math.round(volume * 100)}`),
  };
}
