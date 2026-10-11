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
import type { Track } from '@spotify/web-api-ts-sdk';

interface PlaybackProgress {
  position: number;
  duration: number;
  timestamp: number;
  paused: boolean;
}

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

/**
 * Whether this browser can play audio itself. Spotify's Web Playback SDK only
 * runs in desktop browsers; on phones it never comes up, and playback has to
 * go to the Spotify app (or a speaker) through Spotify Connect instead.
 */
export type LocalPlayerStatus = 'connecting' | 'ready' | 'unavailable';

interface SpotifyPlayerContextValue {
  /** True when there is a device to send playback to. */
  isReady: boolean;
  isPaused: boolean;
  currentTrack: Track | null;
  deviceId: string | null;
  volume: number;
  /** Where playback goes: this browser, or a Connect device. */
  outputDevice: PlaybackDevice | null;
  /** Devices from the last refresh. */
  devices: PlaybackDevice[];
  localStatus: LocalPlayerStatus;
  /** Why this browser can't play, in plain words, when it can't. */
  localProblem: string | null;
  /** The last thing Spotify refused, in plain words. */
  playbackError: string | null;
  /** Set when something was asked to play with nowhere to play it. */
  needsDevice: boolean;
  dismissDevicePrompt: () => void;
  refreshDevices: () => Promise<void>;
  chooseDevice: (device: PlaybackDevice) => Promise<void>;
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

/** How long the SDK gets to come up before we treat this browser as unable to play. */
const LOCAL_PLAYER_TIMEOUT_MS = 10_000;
/** How often a Connect device is asked what it is playing. */
const REMOTE_POLL_MS = 3_000;

const LOCAL_PLAYER_NAME = 'prelude.fm';

const NO_LOCAL_PLAYBACK = 'Spotify only plays inside desktop browsers, not this one.';

/**
 * Remembers, per browser, that the in-browser player never came up, so a phone
 * doesn't sit through the timeout on every launch before offering its devices.
 * The SDK still gets its chance each time; if it does come up, the note goes.
 */
const LOCAL_UNAVAILABLE_KEY = 'prelude.localPlayerUnavailable';

function rememberLocalUnavailable(unavailable: boolean) {
  try {
    if (unavailable) localStorage.setItem(LOCAL_UNAVAILABLE_KEY, '1');
    else localStorage.removeItem(LOCAL_UNAVAILABLE_KEY);
  } catch {
    // Private windows can refuse storage; the timeout still applies.
  }
}

function knownLocalUnavailable(): boolean {
  try {
    return localStorage.getItem(LOCAL_UNAVAILABLE_KEY) === '1';
  } catch {
    return false;
  }
}

interface SpotifyApiDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  supports_volume?: boolean;
  volume_percent: number | null;
}

interface SpotifyApiPlaybackState {
  device: SpotifyApiDevice;
  progress_ms: number | null;
  is_playing: boolean;
  item: (Track & { type: 'track' }) | { type: 'episode' } | null;
}

class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The Web API's player endpoints answer most commands with an empty 204, which
 * the typed SDK tries to parse as JSON, so these go through fetch directly.
 */
async function spotifyApi(
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

/** Spotify's refusals, said the way a listener would want to hear them. */
function describeFailure(err: unknown, device: PlaybackDevice | null): string {
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

function toDevice(d: SpotifyApiDevice, localId: string | null): PlaybackDevice | null {
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

interface SpotifyPlayerProviderProps {
  accessToken: string;
  children: ReactNode;
}

export function SpotifyPlayerProvider({ accessToken, children }: SpotifyPlayerProviderProps) {
  const [state, setState] = useState({
    isPaused: true,
    currentTrack: null as Track | null,
    volume: 1,
  });
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState<LocalPlayerStatus>('connecting');
  const [localProblem, setLocalProblem] = useState<string | null>(null);
  const [outputDevice, setOutputDevice] = useState<PlaybackDevice | null>(null);
  const [devices, setDevices] = useState<PlaybackDevice[]>([]);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [pendingUris, setPendingUris] = useState<string[] | null>(null);

  const playerRef = useRef<Spotify.Player | null>(null);
  const accessTokenRef = useRef(accessToken);
  const outputRef = useRef<PlaybackDevice | null>(null);
  const localDeviceIdRef = useRef<string | null>(null);
  const progressRef = useRef<PlaybackProgress>({
    position: 0,
    duration: 0,
    timestamp: 0,
    paused: true,
  });
  const progressSubscribersRef = useRef<Set<(progress: PlaybackProgress) => void>>(new Set());

  // Keep the refs in sync with the latest values for the SDK's callbacks.
  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);
  useEffect(() => {
    outputRef.current = outputDevice;
  }, [outputDevice]);
  useEffect(() => {
    localDeviceIdRef.current = localDeviceId;
  }, [localDeviceId]);

  const notifyProgressSubscribers = useCallback(() => {
    const progress = progressRef.current;
    progressSubscribersRef.current.forEach((cb) => cb(progress));
  }, []);

  const localDevice = useCallback(
    (id: string): PlaybackDevice => ({
      id,
      name: 'This browser',
      type: 'Computer',
      isThisBrowser: true,
      isRestricted: false,
      supportsVolume: true,
    }),
    [],
  );

  /** Take on what a Connect device reports it is playing. */
  const applyRemoteState = useCallback((remote: SpotifyApiPlaybackState | null) => {
    if (!remote) {
      progressRef.current = { position: 0, duration: 0, timestamp: Date.now(), paused: true };
      setState((s) => ({ ...s, isPaused: true, currentTrack: null }));
      return;
    }
    const track = remote.item?.type === 'track' ? (remote.item as Track) : null;
    progressRef.current = {
      position: remote.progress_ms ?? 0,
      duration: track?.duration_ms ?? 0,
      timestamp: Date.now(),
      paused: !remote.is_playing,
    };
    setState((s) => ({
      ...s,
      isPaused: !remote.is_playing,
      currentTrack: track,
      volume: remote.device.volume_percent !== null ? remote.device.volume_percent / 100 : s.volume,
    }));
  }, []);

  /** Ask Spotify what is playing where, for a Connect device. */
  const pollRemote = useCallback(async () => {
    const output = outputRef.current;
    if (!output || output.isThisBrowser) return;
    try {
      const res = await spotifyApi(accessTokenRef.current, '/me/player');
      if (res.status === 204) {
        applyRemoteState(null);
        return;
      }
      const remote = (await res.json()) as SpotifyApiPlaybackState;
      // Playback moved — someone picked another device in the Spotify app.
      // Follow it rather than keep showing a device that has gone quiet.
      const moved = toDevice(remote.device, localDeviceIdRef.current);
      if (moved && moved.id !== output.id) {
        setOutputDevice(moved.isThisBrowser ? localDevice(moved.id) : moved);
        if (moved.isThisBrowser) return;
      }
      applyRemoteState(remote);
    } catch (err) {
      console.error('Error reading playback state:', err);
    }
  }, [applyRemoteState, localDevice]);

  const refreshDevices = useCallback(async () => {
    try {
      const res = await spotifyApi(accessTokenRef.current, '/me/player/devices');
      const json = (await res.json()) as { devices: SpotifyApiDevice[] };
      const local = localDeviceIdRef.current;
      const found = json.devices
        .map((d) => toDevice(d, local))
        .filter((d): d is PlaybackDevice => d !== null && !d.isThisBrowser);
      setDevices(local ? [localDevice(local), ...found] : found);
    } catch (err) {
      console.error('Error listing devices:', err);
      setPlaybackError(describeFailure(err, null));
    }
  }, [localDevice]);

  // --- This browser's player ---

  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    document.body.appendChild(script);

    let ready = false;
    // An unsupported browser is worth remembering; an account or sign-in
    // problem is not, since it can be fixed and says something more specific.
    const giveUp = (problem: string, unsupported: boolean) => {
      if (ready) return;
      setLocalStatus('unavailable');
      setLocalProblem(problem);
      if (unsupported) rememberLocalUnavailable(true);
    };
    if (knownLocalUnavailable()) giveUp(NO_LOCAL_PLAYBACK, true);
    const timeout = setTimeout(() => giveUp(NO_LOCAL_PLAYBACK, true), LOCAL_PLAYER_TIMEOUT_MS);

    window.onSpotifyWebPlaybackSDKReady = () => {
      const player = new window.Spotify.Player({
        name: LOCAL_PLAYER_NAME,
        getOAuthToken: (cb) => cb(accessTokenRef.current),
        volume: 1,
      });

      player.addListener('ready', ({ device_id }) => {
        ready = true;
        clearTimeout(timeout);
        rememberLocalUnavailable(false);
        setLocalDeviceId(device_id);
        setLocalStatus('ready');
        setLocalProblem(null);
        setDevices((ds) => [localDevice(device_id), ...ds.filter((d) => !d.isThisBrowser)]);
        // Play here unless the listener already chose somewhere else.
        setOutputDevice((current) => current ?? localDevice(device_id));
      });

      player.addListener('not_ready', ({ device_id }) => {
        console.log('Device ID has gone offline', device_id);
        setLocalStatus('connecting');
        setOutputDevice((current) => (current?.id === device_id ? null : current));
      });

      player.addListener('initialization_error', ({ message }) => {
        console.error('Spotify player initialization error:', message);
        giveUp(NO_LOCAL_PLAYBACK, true);
      });
      player.addListener('account_error', ({ message }) => {
        console.error('Spotify player account error:', message);
        clearTimeout(timeout);
        giveUp('Playing in the browser needs Spotify Premium.', false);
      });
      player.addListener('authentication_error', ({ message }) => {
        console.error('Spotify player authentication error:', message);
        clearTimeout(timeout);
        giveUp('Spotify didn’t accept the sign-in for playing in the browser.', false);
      });

      player.addListener('player_state_changed', (sdkState) => {
        // While a Connect device is playing, this browser's player is idle and
        // its state says nothing about what the listener is hearing.
        if (outputRef.current && !outputRef.current.isThisBrowser) return;
        if (!sdkState) {
          setState((s) => ({ ...s, currentTrack: null, isPaused: true }));
          return;
        }

        progressRef.current = {
          position: sdkState.position,
          duration: sdkState.duration,
          timestamp: Date.now(),
          paused: sdkState.paused,
        };
        notifyProgressSubscribers();

        // SDK track type differs from Web API Track type, cast as needed.
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
      clearTimeout(timeout);
      playerRef.current?.disconnect();
    };
  }, [notifyProgressSubscribers, localDevice]);

  // When this browser can't play, pick up whatever the account is already
  // playing on, so opening the app on a phone shows what the Spotify app is doing.
  useEffect(() => {
    if (localStatus !== 'unavailable' || outputRef.current) return;
    let cancelled = false;
    spotifyApi(accessTokenRef.current, '/me/player')
      .then(async (res) => {
        if (cancelled || res.status === 204) return;
        const remote = (await res.json()) as SpotifyApiPlaybackState;
        const device = toDevice(remote.device, null);
        if (!device || device.isRestricted || outputRef.current) return;
        setOutputDevice(device);
        applyRemoteState(remote);
      })
      .catch((err) => console.error('Error reading playback state:', err));
    return () => {
      cancelled = true;
    };
  }, [localStatus, applyRemoteState]);

  // Follow a Connect device while it is the output and the page is in view.
  useEffect(() => {
    if (!outputDevice || outputDevice.isThisBrowser) return;
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) return;
      pollRemote();
      interval = setInterval(pollRemote, REMOTE_POLL_MS);
    };
    const stop = () => {
      if (interval) clearInterval(interval);
      interval = null;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [outputDevice, pollRemote]);

  // --- Actions ---

  /** Run a Web API command against the output device, then re-read its state. */
  const remoteCommand = useCallback(
    async (method: string, path: string, body?: unknown) => {
      const output = outputRef.current;
      if (!output) return;
      const sep = path.includes('?') ? '&' : '?';
      try {
        await spotifyApi(
          accessTokenRef.current,
          `${path}${sep}device_id=${encodeURIComponent(output.id)}`,
          { method, body },
        );
        setPlaybackError(null);
      } catch (err) {
        console.error(`Spotify ${method} ${path} failed:`, err);
        setPlaybackError(describeFailure(err, output));
      }
      // Connect devices take a moment to act on a command.
      if (!output.isThisBrowser) setTimeout(pollRemote, 600);
    },
    [pollRemote],
  );

  const playOn = useCallback(
    async (device: PlaybackDevice, uris: string[]) => {
      try {
        await spotifyApi(
          accessTokenRef.current,
          `/me/player/play?device_id=${encodeURIComponent(device.id)}`,
          { method: 'PUT', body: { uris } },
        );
        setPlaybackError(null);
      } catch (err) {
        console.error('Error starting playback:', err);
        setPlaybackError(describeFailure(err, device));
      }
      if (!device.isThisBrowser) setTimeout(pollRemote, 600);
    },
    [pollRemote],
  );

  const play = useCallback(
    async (uris: string[]) => {
      const output = outputRef.current;
      if (!output) {
        // Nowhere to play yet: hold the request and ask where.
        setPendingUris(uris);
        refreshDevices();
        return;
      }
      await playOn(output, uris);
    },
    [playOn, refreshDevices],
  );

  const chooseDevice = useCallback(
    async (device: PlaybackDevice) => {
      const previous = outputRef.current;
      outputRef.current = device;
      setOutputDevice(device);
      setPlaybackError(null);

      if (pendingUris) {
        setPendingUris(null);
        await playOn(device, pendingUris);
        return;
      }
      // With nothing loaded there is nothing to carry over; the device simply
      // becomes where the next play goes.
      if (previous?.id === device.id || progressRef.current.duration === 0) return;
      // Carry on whatever was playing, on the new device.
      try {
        await spotifyApi(accessTokenRef.current, '/me/player', {
          method: 'PUT',
          body: { device_ids: [device.id], play: !progressRef.current.paused },
        });
      } catch (err) {
        console.error('Error moving playback:', err);
        setPlaybackError(describeFailure(err, device));
      }
      if (!device.isThisBrowser) setTimeout(pollRemote, 600);
    },
    [pendingUris, playOn, pollRemote],
  );

  const dismissDevicePrompt = useCallback(() => setPendingUris(null), []);

  const isLocal = () => outputRef.current?.isThisBrowser ?? false;

  const pause = useCallback(async () => {
    if (isLocal()) await playerRef.current?.pause();
    else await remoteCommand('PUT', '/me/player/pause');
  }, [remoteCommand]);

  const resume = useCallback(async () => {
    if (isLocal()) await playerRef.current?.resume();
    else await remoteCommand('PUT', '/me/player/play');
  }, [remoteCommand]);

  const togglePlay = useCallback(async () => {
    if (isLocal()) {
      await playerRef.current?.togglePlay();
      return;
    }
    const paused = progressRef.current.paused;
    // Answer the tap at once; the next poll corrects it if Spotify disagrees.
    progressRef.current = {
      ...progressRef.current,
      position: getPosition(progressRef.current),
      timestamp: Date.now(),
      paused: !paused,
    };
    setState((s) => ({ ...s, isPaused: !paused }));
    await remoteCommand('PUT', paused ? '/me/player/play' : '/me/player/pause');
  }, [remoteCommand]);

  const seek = useCallback(
    async (positionMs: number) => {
      if (isLocal()) {
        await playerRef.current?.seek(positionMs);
        return;
      }
      progressRef.current = { ...progressRef.current, position: positionMs, timestamp: Date.now() };
      await remoteCommand('PUT', `/me/player/seek?position_ms=${Math.round(positionMs)}`);
    },
    [remoteCommand],
  );

  const previousTrack = useCallback(async () => {
    if (isLocal()) await playerRef.current?.previousTrack();
    else await remoteCommand('POST', '/me/player/previous');
  }, [remoteCommand]);

  const nextTrack = useCallback(async () => {
    if (isLocal()) await playerRef.current?.nextTrack();
    else await remoteCommand('POST', '/me/player/next');
  }, [remoteCommand]);

  const setVolume = useCallback(
    async (volume: number) => {
      if (isLocal()) await playerRef.current?.setVolume(volume);
      else
        await remoteCommand('PUT', `/me/player/volume?volume_percent=${Math.round(volume * 100)}`);
      setState((s) => ({ ...s, volume }));
    },
    [remoteCommand],
  );

  const getProgress = useCallback((): PlaybackProgress => {
    const p = progressRef.current;
    return { ...p, position: getPosition(p) };
  }, []);

  const subscribeToProgress = useCallback((callback: (progress: PlaybackProgress) => void) => {
    progressSubscribersRef.current.add(callback);
    return () => {
      progressSubscribersRef.current.delete(callback);
    };
  }, []);

  const value: SpotifyPlayerContextValue = {
    ...state,
    isReady: outputDevice !== null,
    deviceId: outputDevice?.id ?? null,
    outputDevice,
    devices,
    localStatus,
    localProblem,
    playbackError,
    needsDevice: pendingUris !== null,
    dismissDevicePrompt,
    refreshDevices,
    chooseDevice,
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

/** Where playback is now, counting the time since Spotify last reported it. */
function getPosition(p: PlaybackProgress): number {
  if (p.paused) return p.position;
  const elapsed = Date.now() - p.timestamp;
  return p.duration > 0 ? Math.min(p.position + elapsed, p.duration) : p.position + elapsed;
}

export function useSpotifyPlayer(): SpotifyPlayerContextValue {
  const context = useContext(SpotifyPlayerContext);
  if (!context) {
    throw new Error('useSpotifyPlayer must be used within SpotifyPlayerProvider');
  }
  return context;
}
