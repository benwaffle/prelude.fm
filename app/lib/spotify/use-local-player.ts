'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Whether this browser can play audio itself through Spotify's Web Playback
 * SDK. When it can't (an unsupported browser, no Premium), playback can still
 * go to the Spotify app or a speaker through Spotify Connect.
 */
export type LocalPlayer =
  /**
   * Still starting, or reconnecting after the player dropped. A player that
   * dropped keeps its device id, so the device list still knows it as this
   * browser rather than as some other device.
   */
  | { status: 'connecting'; deviceId: string | null }
  | { status: 'ready'; deviceId: string }
  /** Why this browser can't play, in plain words. */
  | { status: 'unavailable'; problem: string };

export interface LocalPlayerEvents {
  onReady: (deviceId: string) => void;
  onNotReady: (deviceId: string) => void;
  onStateChange: (state: Spotify.PlaybackState | null) => void;
}

/** How long the SDK gets to come up before we treat this browser as unable to play. */
const LOCAL_PLAYER_TIMEOUT_MS = 10_000;

const LOCAL_PLAYER_NAME = 'prelude.fm';

const NO_LOCAL_PLAYBACK = 'Spotify’s player didn’t start in this browser.';

/**
 * This tab's own Spotify player: loads the SDK once, connects, and reports
 * what it is doing. The events are read through a ref, so the player is set
 * up once however often the caller re-renders.
 */
export function useLocalPlayer(
  getToken: () => string,
  events: LocalPlayerEvents,
): {
  local: LocalPlayer;
  /** The player, once the SDK has made one. */
  player: () => Spotify.Player | null;
  /** The browser's device id as last known, for telling it apart in device lists. */
  deviceId: () => string | null;
} {
  const [local, setLocal] = useState<LocalPlayer>({ status: 'connecting', deviceId: null });
  const playerRef = useRef<Spotify.Player | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const live = useRef({ getToken, events });
  useEffect(() => {
    live.current = { getToken, events };
  });

  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    document.body.appendChild(script);

    let ready = false;
    const giveUp = (problem: string) => {
      if (ready) return;
      setLocal({ status: 'unavailable', problem });
    };
    const timeout = setTimeout(() => giveUp(NO_LOCAL_PLAYBACK), LOCAL_PLAYER_TIMEOUT_MS);

    window.onSpotifyWebPlaybackSDKReady = () => {
      const player = new window.Spotify.Player({
        name: LOCAL_PLAYER_NAME,
        getOAuthToken: (cb) => cb(live.current.getToken()),
        volume: 1,
      });

      player.addListener('ready', ({ device_id }) => {
        ready = true;
        clearTimeout(timeout);
        deviceIdRef.current = device_id;
        setLocal({ status: 'ready', deviceId: device_id });
        live.current.events.onReady(device_id);
      });

      player.addListener('not_ready', ({ device_id }) => {
        console.log('Device ID has gone offline', device_id);
        setLocal({ status: 'connecting', deviceId: deviceIdRef.current });
        live.current.events.onNotReady(device_id);
      });

      player.addListener('initialization_error', ({ message }) => {
        console.error('Spotify player initialization error:', message);
        giveUp(NO_LOCAL_PLAYBACK);
      });
      player.addListener('account_error', ({ message }) => {
        console.error('Spotify player account error:', message);
        clearTimeout(timeout);
        giveUp('Playing in the browser needs Spotify Premium.');
      });
      player.addListener('authentication_error', ({ message }) => {
        console.error('Spotify player authentication error:', message);
        clearTimeout(timeout);
        giveUp('Spotify didn’t accept the sign-in for playing in the browser.');
      });

      player.addListener('player_state_changed', (state) =>
        live.current.events.onStateChange(state),
      );

      player.connect();
      playerRef.current = player;
    };

    return () => {
      clearTimeout(timeout);
      playerRef.current?.disconnect();
    };
  }, []);

  const player = useCallback(() => playerRef.current, []);
  const deviceId = useCallback(() => deviceIdRef.current, []);
  return { local, player, deviceId };
}
