'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { createSpotifySdk } from '@/lib/spotify-sdk';
import type { Track } from '@spotify/web-api-ts-sdk';

const spotifyClientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? '';

interface PlaybackProgress {
  position: number;
  duration: number;
  timestamp: number;
  paused: boolean;
}

interface SpotifyPlayerContextValue {
  isReady: boolean;
  isPaused: boolean;
  currentTrack: Track | null;
  deviceId: string | null;
  volume: number;
  play: (uris: string[]) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  togglePlay: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  previousTrack: () => Promise<void>;
  nextTrack: () => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  getProgress: () => PlaybackProgress;
  subscribeToProgress: (callback: (progress: PlaybackProgress) => void) => () => void;
}

const SpotifyPlayerContext = createContext<SpotifyPlayerContextValue | null>(null);

interface SpotifyPlayerProviderProps {
  accessToken: string;
  children: ReactNode;
}

export function SpotifyPlayerProvider({ accessToken, children }: SpotifyPlayerProviderProps) {
  const [state, setState] = useState({
    isReady: false,
    isPaused: true,
    currentTrack: null as Track | null,
    deviceId: null as string | null,
    volume: 1,
  });

  const playerRef = useRef<Spotify.Player | null>(null);
  const progressRef = useRef<PlaybackProgress>({
    position: 0,
    duration: 0,
    timestamp: 0,
    paused: true,
  });
  const progressSubscribersRef = useRef<Set<(progress: PlaybackProgress) => void>>(new Set());

  // Notify progress subscribers
  const notifyProgressSubscribers = useCallback(() => {
    const progress = progressRef.current;
    progressSubscribersRef.current.forEach((cb) => cb(progress));
  }, []);

  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    document.body.appendChild(script);

    window.onSpotifyWebPlaybackSDKReady = () => {
      const player = new window.Spotify.Player({
        name: 'prelude.fm',
        getOAuthToken: (cb) => cb(accessToken),
        volume: 1,
      });

      player.addListener('ready', ({ device_id }) => {
        console.log('Ready with Device ID', device_id);
        setState((s) => ({ ...s, deviceId: device_id, isReady: true }));
      });

      player.addListener('not_ready', ({ device_id }) => {
        console.log('Device ID has gone offline', device_id);
        setState((s) => ({ ...s, isReady: false }));
      });

      player.addListener('player_state_changed', (sdkState) => {
        console.log('Player state changed:', sdkState);
        if (!sdkState) {
          setState((s) => ({ ...s, currentTrack: null, isPaused: true }));
          return;
        }

        // Update progress ref (no re-render)
        progressRef.current = {
          position: sdkState.position,
          duration: sdkState.duration,
          timestamp: Date.now(),
          paused: sdkState.paused,
        };
        notifyProgressSubscribers();

        // Update state (triggers re-render only for these changes)
        // Note: SDK track type differs from Web API Track type, cast as needed
        setState((s) => ({
          ...s,
          isPaused: sdkState.paused,
          currentTrack: sdkState.track_window.current_track as unknown as Track,
        }));
      });

      player.connect();
      playerRef.current = player;
    };

    return () => {
      playerRef.current?.disconnect();
    };
  }, [accessToken, notifyProgressSubscribers]);

  // --- Actions (stable references) ---

  const play = useCallback(
    async (uris: string[]) => {
      if (!state.deviceId) return;
      const spotify = createSpotifySdk(accessToken, spotifyClientId);
      await spotify.player.startResumePlayback(state.deviceId, undefined, uris);
    },
    [state.deviceId, accessToken],
  );

  const pause = useCallback(async () => {
    await playerRef.current?.pause();
  }, []);

  const resume = useCallback(async () => {
    await playerRef.current?.resume();
  }, []);

  const togglePlay = useCallback(async () => {
    await playerRef.current?.togglePlay();
  }, []);

  const seek = useCallback(async (positionMs: number) => {
    await playerRef.current?.seek(positionMs);
  }, []);

  const previousTrack = useCallback(async () => {
    await playerRef.current?.previousTrack();
  }, []);

  const nextTrack = useCallback(async () => {
    await playerRef.current?.nextTrack();
  }, []);

  const setVolume = useCallback(async (volume: number) => {
    await playerRef.current?.setVolume(volume);
    setState((s) => ({ ...s, volume }));
  }, []);

  const getProgress = useCallback((): PlaybackProgress => {
    const p = progressRef.current;
    if (p.paused) {
      return p;
    }
    // Calculate current position based on elapsed time
    const elapsed = Date.now() - p.timestamp;
    return {
      ...p,
      position: Math.min(p.position + elapsed, p.duration),
    };
  }, []);

  const subscribeToProgress = useCallback((callback: (progress: PlaybackProgress) => void) => {
    progressSubscribersRef.current.add(callback);
    return () => {
      progressSubscribersRef.current.delete(callback);
    };
  }, []);

  const value: SpotifyPlayerContextValue = {
    ...state,
    play,
    pause,
    resume,
    togglePlay,
    seek,
    previousTrack,
    nextTrack,
    setVolume,
    getProgress,
    subscribeToProgress,
  };

  return <SpotifyPlayerContext.Provider value={value}>{children}</SpotifyPlayerContext.Provider>;
}

export function useSpotifyPlayer(): SpotifyPlayerContextValue {
  const context = useContext(SpotifyPlayerContext);
  if (!context) {
    throw new Error('useSpotifyPlayer must be used within SpotifyPlayerProvider');
  }
  return context;
}
