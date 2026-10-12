'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Track } from '@spotify/web-api-ts-sdk';
import type { QueueEntry } from './prelude';
import {
  describeFailure,
  listDevices,
  localDevice,
  readPlaybackState,
  spotifyApi,
  toDevice,
  type PlaybackDevice,
  type SpotifyApiPlaybackState,
} from './spotify/web-api';
import {
  fromSdkTrack,
  fromWebApiTrack,
  sameTrack,
  trackUris,
  type NowPlayingTrack,
} from './spotify/now-playing-track';
import { createProgressStore, positionAt, type PlaybackProgress } from './spotify/progress';
import {
  EMPTY_QUEUE,
  handedUris,
  queueReducer,
  restOfCurrent,
  type QueueAction,
  type Segment,
} from './spotify/playback-queue';
import {
  connectTransport,
  localTransport,
  type PlaybackTransport,
  type Send,
} from './spotify/transport';
import { useLocalPlayer, type LocalPlayer } from './spotify/use-local-player';

export type { PlaybackDevice } from './spotify/web-api';
export type { LocalPlayer } from './spotify/use-local-player';

export interface PlayerState {
  isReady: boolean;
  isPaused: boolean;
  currentTrack: NowPlayingTrack | null;
  volume: number;
  outputDevice: PlaybackDevice | null;
  devices: PlaybackDevice[];
  local: LocalPlayer;
  playbackError: string | null;
  needsDevice: boolean;
  queue: QueueEntry[];
}

/** Stable for the life of the player, so holding them re-renders nothing. */
export interface PlayerActions {
  dismissDevicePrompt: () => void;
  refreshDevices: () => Promise<void>;
  chooseDevice: (device: PlaybackDevice) => Promise<void>;
  play: (uris: string[]) => Promise<void>;
  addToQueue: (entry: Omit<QueueEntry, 'id'>) => void;
  removeFromQueue: (id: string) => void;
  clearQueue: () => void;
  playQueue: () => Promise<void>;
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

const PlayerStateContext = createContext<PlayerState | null>(null);
const PlayerActionsContext = createContext<PlayerActions | null>(null);

/** How often a Connect device is asked what it is playing. */
const REMOTE_POLL_MS = 3_000;
/** Connect devices take a moment to act on a command before they're re-read. */
const CONNECT_SETTLE_MS = 600;
/** Queue edits made in quick succession go to Spotify as one. */
const QUEUE_SYNC_DELAY_MS = 400;

let nextQueueId = 0;

interface Playback {
  isPaused: boolean;
  currentTrack: NowPlayingTrack | null;
  volume: number;
}

// The player's callbacks outlive renders (SDK listeners, timers, polls), so they read through the
// getter.
function useCurrentState<T>(initial: T): [T, () => T, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const get = useCallback(() => ref.current, []);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, get, set];
}

export function SpotifyPlayerProvider({
  accessToken,
  children,
}: {
  accessToken: string;
  children: ReactNode;
}) {
  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);
  const getToken = useCallback(() => tokenRef.current, []);

  const [progress] = useState(createProgressStore);
  const [playback, getPlayback, setPlayback] = useCurrentState<Playback>({
    isPaused: true,
    currentTrack: null,
    volume: 1,
  });
  const [outputDevice, getOutput, setOutput] = useCurrentState<PlaybackDevice | null>(null);
  const [pendingUris, getPendingUris, setPendingUris] = useCurrentState<string[] | null>(null);
  const [queueState, getQueue, setQueueState] = useCurrentState(EMPTY_QUEUE);
  const [devices, setDevices] = useState<PlaybackDevice[]>([]);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  /** Set once the listener picks a device, so a late browser player doesn't take over. */
  const userChoseRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatch = useCallback(
    (action: QueueAction) => {
      const next = queueReducer(getQueue(), action);
      if (next !== getQueue()) setQueueState(next);
    },
    [getQueue, setQueueState],
  );

  const report = useCallback(
    (next: Partial<Playback>) => {
      const now = getPlayback();
      const track =
        next.currentTrack === undefined || sameTrack(next.currentTrack, now.currentTrack)
          ? now.currentTrack
          : next.currentTrack;
      const isPaused = next.isPaused ?? now.isPaused;
      const volume = next.volume ?? now.volume;
      if (track !== now.currentTrack || isPaused !== now.isPaused || volume !== now.volume) {
        setPlayback({ currentTrack: track, isPaused, volume });
      }
      // A queued recording that has started leaves the queue.
      if (next.currentTrack) dispatch({ type: 'trackStarted', uris: trackUris(next.currentTrack) });
    },
    [getPlayback, setPlayback, dispatch],
  );

  const {
    local,
    player,
    deviceId: localDeviceId,
  } = useLocalPlayer(getToken, {
    onReady: (deviceId) => {
      setDevices((ds) => [localDevice(deviceId), ...ds.filter((d) => !d.isThisBrowser)]);
      // Play here unless the listener already chose; a device picked only because this player was
      // slow gives way.
      const current = getOutput();
      setOutput(current && userChoseRef.current ? current : localDevice(deviceId));
    },
    onNotReady: (deviceId) => {
      if (getOutput()?.id === deviceId) setOutput(null);
    },
    onStateChange: (state) => {
      // While a Connect device is playing, this browser's player state says nothing about what the
      // listener hears.
      const output = getOutput();
      if (output && !output.isThisBrowser) return;
      if (!state) {
        report({ currentTrack: null, isPaused: true });
        return;
      }
      progress.set({
        position: state.position,
        duration: state.duration,
        timestamp: Date.now(),
        paused: state.paused,
      });
      report({
        isPaused: state.paused,
        currentTrack: fromSdkTrack(state.track_window.current_track),
      });
    },
  });

  const applyRemoteState = useCallback(
    (remote: SpotifyApiPlaybackState | null) => {
      if (!remote) {
        progress.set({ position: 0, duration: 0, timestamp: Date.now(), paused: true });
        report({ isPaused: true, currentTrack: null });
        return;
      }
      const track = remote.item?.type === 'track' ? fromWebApiTrack(remote.item as Track) : null;
      progress.set({
        position: remote.progress_ms ?? 0,
        duration: track?.durationMs ?? 0,
        timestamp: Date.now(),
        paused: !remote.is_playing,
      });
      report({
        isPaused: !remote.is_playing,
        currentTrack: track,
        ...(remote.device.volume_percent !== null && {
          volume: remote.device.volume_percent / 100,
        }),
      });
    },
    [progress, report],
  );

  const pollRemote = useCallback(async () => {
    const output = getOutput();
    if (!output || output.isThisBrowser) return;
    try {
      const remote = await readPlaybackState(getToken());
      if (!remote) {
        applyRemoteState(null);
        return;
      }
      // Playback moved (someone picked another device in the Spotify app): follow it.
      const moved = toDevice(remote.device, localDeviceId());
      if (moved && moved.id !== output.id) {
        setOutput(moved.isThisBrowser ? localDevice(moved.id) : moved);
        if (moved.isThisBrowser) return;
      }
      applyRemoteState(remote);
    } catch (err) {
      console.error('Error reading playback state:', err);
    }
  }, [getOutput, setOutput, getToken, localDeviceId, applyRemoteState]);

  const refreshDevices = useCallback(async () => {
    try {
      const local = localDeviceId();
      const found = (await listDevices(getToken()))
        .map((d) => toDevice(d, local))
        .filter((d): d is PlaybackDevice => d !== null && !d.isThisBrowser);
      setDevices(local ? [localDevice(local), ...found] : found);
    } catch (err) {
      console.error('Error listing devices:', err);
      setPlaybackError(describeFailure(err, null));
    }
  }, [getToken, localDeviceId]);

  // When this browser can't play, pick up whatever the account is already playing on.
  useEffect(() => {
    if (local.status !== 'unavailable' || getOutput()) return;
    let cancelled = false;
    readPlaybackState(getToken())
      .then((remote) => {
        if (cancelled || !remote) return;
        const device = toDevice(remote.device, null);
        if (!device || device.isRestricted || getOutput()) return;
        setOutput(device);
        applyRemoteState(remote);
      })
      .catch((err) => console.error('Error reading playback state:', err));
    return () => {
      cancelled = true;
    };
  }, [local.status, getOutput, setOutput, getToken, applyRemoteState]);

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

  const send: Send = useCallback(
    async (device, what, request) => {
      try {
        await request(getToken());
        setPlaybackError(null);
      } catch (err) {
        console.error(`${what} failed:`, err);
        setPlaybackError(describeFailure(err, device));
      }
      if (!device.isThisBrowser) setTimeout(pollRemote, CONNECT_SETTLE_MS);
    },
    [getToken, pollRemote],
  );

  const transportFor = useCallback(
    (device: PlaybackDevice | null): PlaybackTransport =>
      device?.isThisBrowser
        ? localTransport(player(), device, send)
        : connectTransport(device, send, progress, (isPaused) => report({ isPaused })),
    [player, send, progress, report],
  );

  const playWithQueue = useCallback(
    async (start: Segment, positionMs?: number) => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      dispatch({ type: 'handedOver', start });
      const uris = handedUris(getQueue());
      const output = getOutput();
      if (!output) {
        // Nowhere to play yet: hold the request and ask where.
        setPendingUris(uris);
        refreshDevices();
        return;
      }
      await transportFor(output).play(uris, positionMs);
    },
    [dispatch, getQueue, getOutput, setPendingUris, refreshDevices, transportFor],
  );

  const play = useCallback(
    (uris: string[]) => playWithQueue({ entryId: null, uris }),
    [playWithQueue],
  );

  // Spotify can't edit a list it is already playing, so the rest is handed over again; that costs a
  // pause, so it waits for resume while paused.
  const syncQueue = useCallback(async () => {
    const track = getPlayback().currentTrack;
    if (!track) return;
    const rest = restOfCurrent(getQueue(), { uris: trackUris(track), uri: track.uri });
    await playWithQueue({ entryId: null, uris: rest }, positionAt(progress.get(), Date.now()));
  }, [getPlayback, getQueue, playWithQueue, progress]);

  const queueChanged = useCallback(() => {
    if (!getPlayback().currentTrack) return;
    dispatch({ type: 'changed' });
    if (progress.get().paused) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => void syncQueue(), QUEUE_SYNC_DELAY_MS);
  }, [getPlayback, dispatch, progress, syncQueue]);

  const addToQueue = useCallback(
    (entry: Omit<QueueEntry, 'id'>) => {
      if (entry.uris.length === 0) return;
      dispatch({ type: 'add', entry: { ...entry, id: `q${++nextQueueId}` } });
      queueChanged();
    },
    [dispatch, queueChanged],
  );

  const removeFromQueue = useCallback(
    (id: string) => {
      dispatch({ type: 'remove', id });
      queueChanged();
    },
    [dispatch, queueChanged],
  );

  const clearQueue = useCallback(() => {
    if (getQueue().queue.length === 0) return;
    dispatch({ type: 'clear' });
    queueChanged();
  }, [getQueue, dispatch, queueChanged]);

  const playQueue = useCallback(async () => {
    const first = getQueue().queue[0];
    if (!first) return;
    dispatch({ type: 'takeFirst' });
    await playWithQueue({ entryId: null, uris: first.uris });
  }, [getQueue, dispatch, playWithQueue]);

  const chooseDevice = useCallback(
    async (device: PlaybackDevice) => {
      const previous = getOutput();
      userChoseRef.current = true;
      setOutput(device);
      setPlaybackError(null);

      const pending = getPendingUris();
      if (pending) {
        setPendingUris(null);
        await transportFor(device).play(pending);
        return;
      }
      // With nothing loaded there is nothing to carry over; the device becomes where the next play
      // goes.
      if (previous?.id === device.id || progress.get().duration === 0) return;
      await send(device, 'Moving playback', (token) =>
        spotifyApi(token, '/me/player', {
          method: 'PUT',
          body: { device_ids: [device.id], play: !progress.get().paused },
        }),
      );
    },
    [getOutput, setOutput, getPendingUris, setPendingUris, transportFor, progress, send],
  );

  const dismissDevicePrompt = useCallback(() => setPendingUris(null), [setPendingUris]);

  const transport = useCallback(() => transportFor(getOutput()), [transportFor, getOutput]);

  const pause = useCallback(() => transport().pause(), [transport]);

  const resume = useCallback(async () => {
    if (getQueue().dirty) await syncQueue();
    else await transport().resume();
  }, [getQueue, syncQueue, transport]);

  const togglePlay = useCallback(async () => {
    if (getQueue().dirty && progress.get().paused) await syncQueue();
    else await transport().toggle();
  }, [getQueue, progress, syncQueue, transport]);

  const seek = useCallback((positionMs: number) => transport().seek(positionMs), [transport]);
  const previousTrack = useCallback(() => transport().previous(), [transport]);
  const nextTrack = useCallback(() => transport().next(), [transport]);

  const setVolume = useCallback(
    async (volume: number) => {
      await transport().setVolume(volume);
      report({ volume });
    },
    [transport, report],
  );

  const getProgress = useCallback((): PlaybackProgress => {
    const p = progress.get();
    return { ...p, position: positionAt(p, Date.now()) };
  }, [progress]);

  const state = useMemo<PlayerState>(
    () => ({
      ...playback,
      isReady: outputDevice !== null,
      outputDevice,
      devices,
      local,
      playbackError,
      needsDevice: pendingUris !== null,
      queue: queueState.queue,
    }),
    [playback, outputDevice, devices, local, playbackError, pendingUris, queueState.queue],
  );

  const actions = useMemo<PlayerActions>(
    () => ({
      dismissDevicePrompt,
      refreshDevices,
      chooseDevice,
      play,
      addToQueue,
      removeFromQueue,
      clearQueue,
      playQueue,
      pause,
      resume,
      togglePlay,
      seek,
      previousTrack,
      nextTrack,
      setVolume,
      getProgress,
      subscribeToProgress: progress.subscribe,
    }),
    [
      dismissDevicePrompt,
      refreshDevices,
      chooseDevice,
      play,
      addToQueue,
      removeFromQueue,
      clearQueue,
      playQueue,
      pause,
      resume,
      togglePlay,
      seek,
      previousTrack,
      nextTrack,
      setVolume,
      getProgress,
      progress,
    ],
  );

  return (
    <PlayerActionsContext.Provider value={actions}>
      <PlayerStateContext.Provider value={state}>{children}</PlayerStateContext.Provider>
    </PlayerActionsContext.Provider>
  );
}

export function usePlayer(): PlayerState {
  const context = useContext(PlayerStateContext);
  if (!context) throw new Error('usePlayer must be used within SpotifyPlayerProvider');
  return context;
}

export function usePlayerActions(): PlayerActions {
  const context = useContext(PlayerActionsContext);
  if (!context) throw new Error('usePlayerActions must be used within SpotifyPlayerProvider');
  return context;
}
