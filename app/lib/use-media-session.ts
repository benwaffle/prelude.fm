'use client';

import { useEffect, useRef } from 'react';

export interface MediaSessionTrack {
  title: string;
  artist: string;
  album: string;
  cover: string | null;
}

interface MediaSessionOptions {
  /** Only the in-browser player needs this; a Connect device shows its own. */
  active: boolean;
  track: MediaSessionTrack | null;
  isPaused: boolean;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeek: (positionMs: number) => void;
  getProgress: () => { position: number; duration: number; paused: boolean };
  subscribeToProgress: (callback: () => void) => () => void;
}

/** How long after Spotify starts a movement the loop is restarted. */
const LOOP_RESTART_DELAY_MS = 4000;
/** Long enough for Firefox to count the loop as stopped. */
const LOOP_RESTART_GAP_MS = 300;

/** iPhones and iPads give one page one playing sound at a time. */
function isAppleTouch(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}

// Spotify plays inside its own frame, and browsers give the notification to a frame making sound,
// so we play our own loop. Chrome asks the top-most frame with a player, and needs a sound over 5s.
// Firefox asks the most recently audible frame and treats under -72 dB as silence: so a 30 Hz tone
// at -60 dB, restarted just after Spotify starts each movement.
export function useMediaSession({
  active,
  track,
  isPaused,
  onTogglePlay,
  onPrevious,
  onNext,
  onSeek,
  getProgress,
  subscribeToProgress,
}: MediaSessionOptions) {
  const silenceRef = useRef<HTMLAudioElement | null>(null);
  const pausedRef = useRef(isPaused);
  useEffect(() => {
    pausedRef.current = isPaused;
  }, [isPaused]);
  const supported = typeof navigator !== 'undefined' && 'mediaSession' in navigator;
  const on = supported && active && track !== null;

  useEffect(() => {
    if (!on || isAppleTouch()) return;
    if (!silenceRef.current) {
      const audio = document.createElement('audio');
      audio.src = '/inaudible.flac';
      audio.loop = true;
      audio.preload = 'auto';
      audio.hidden = true;
      document.body.appendChild(audio);
      silenceRef.current = audio;
    }
    const audio = silenceRef.current;
    if (isPaused) audio.pause();
    else
      audio.play().catch(() => {
        // Refused before any tap on the page; the next play after one works.
      });
  }, [on, isPaused]);

  // Restart after Spotify's sound begins, so Firefox sees this page as the latest to make sound.
  const title = track?.title;
  useEffect(() => {
    if (!on || isPaused || isAppleTouch()) return;
    let restart: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      const audio = silenceRef.current;
      if (!audio || pausedRef.current) return;
      audio.pause();
      restart = setTimeout(() => {
        if (pausedRef.current) return;
        audio.play().catch(() => {
          // As above; the next play tries again.
        });
      }, LOOP_RESTART_GAP_MS);
    }, LOOP_RESTART_DELAY_MS);
    return () => {
      clearTimeout(timer);
      clearTimeout(restart);
    };
  }, [on, isPaused, title]);

  useEffect(() => () => silenceRef.current?.pause(), []);
  useEffect(() => {
    if (!on) silenceRef.current?.pause();
  }, [on]);

  const artist = track?.artist;
  const album = track?.album;
  const cover = track?.cover;
  useEffect(() => {
    if (!on || title === undefined) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
      artwork: cover ? [{ src: cover, sizes: '640x640', type: 'image/jpeg' }] : [],
    });
  }, [on, title, artist, album, cover]);

  useEffect(() => {
    if (!on) return;
    navigator.mediaSession.playbackState = isPaused ? 'paused' : 'playing';
  }, [on, isPaused]);

  // Handlers read the latest callbacks through a ref so they are set once.
  const handlersRef = useRef({ onTogglePlay, onPrevious, onNext, onSeek, getProgress });
  useEffect(() => {
    handlersRef.current = { onTogglePlay, onPrevious, onNext, onSeek, getProgress };
  });

  useEffect(() => {
    if (!on) return;
    const session = navigator.mediaSession;
    const h = handlersRef;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => h.current.onTogglePlay()],
      ['pause', () => h.current.onTogglePlay()],
      ['previoustrack', () => h.current.onPrevious()],
      ['nexttrack', () => h.current.onNext()],
      [
        'seekto',
        (details) => {
          if (details.seekTime !== undefined) h.current.onSeek(details.seekTime * 1000);
        },
      ],
      [
        'seekbackward',
        (details) => {
          const { position } = h.current.getProgress();
          h.current.onSeek(Math.max(0, position - (details.seekOffset ?? 10) * 1000));
        },
      ],
      [
        'seekforward',
        (details) => {
          const { position, duration } = h.current.getProgress();
          h.current.onSeek(Math.min(duration, position + (details.seekOffset ?? 10) * 1000));
        },
      ],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Not every browser knows every action.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // As above.
        }
      }
    };
  }, [on]);

  // The notification's seek bar runs on its own between updates.
  useEffect(() => {
    if (!on || !('setPositionState' in navigator.mediaSession)) return;
    const update = () => {
      const { position, duration } = handlersRef.current.getProgress();
      if (duration <= 0) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: duration / 1000,
          position: Math.min(position, duration) / 1000,
          // Paused is said by playbackState; a rate of 0 is refused.
          playbackRate: 1,
        });
      } catch {
        // A position Spotify reported past the end; the next update fixes it.
      }
    };
    update();
    return subscribeToProgress(update);
  }, [on, title, isPaused, subscribeToProgress]);
}
