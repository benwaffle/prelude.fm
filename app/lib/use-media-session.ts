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
  /** Where the current track is, for the notification's seek bar. */
  getProgress: () => { position: number; duration: number; paused: boolean };
  subscribeToProgress: (callback: () => void) => () => void;
}

/** iPhones and iPads give one page one playing sound at a time. */
function isAppleTouch(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}

/**
 * The lock screen, notification and headphone buttons: what's playing, and
 * controls that reach this page.
 *
 * Spotify's player plays from inside its own frame, and Chrome gives the
 * notification to a frame that is playing sound, so what this page set was
 * never shown: Android showed "prelude.fm" and a play button. A silent loop
 * on this page, playing while Spotify does, makes this page the one Chrome
 * asks. It is 15 seconds long because Chrome gives sounds under 5 seconds no
 * notification.
 */
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
  const supported = typeof navigator !== 'undefined' && 'mediaSession' in navigator;
  const on = supported && active && track !== null;

  // The silent loop follows Spotify's playing and pausing.
  useEffect(() => {
    if (!on || isAppleTouch()) return;
    if (!silenceRef.current) {
      const audio = new Audio('/silence.mp3');
      audio.loop = true;
      audio.preload = 'auto';
      silenceRef.current = audio;
    }
    const audio = silenceRef.current;
    if (isPaused) audio.pause();
    else
      audio.play().catch(() => {
        // Refused before any tap on the page; the next play after one works.
      });
  }, [on, isPaused]);

  useEffect(() => () => silenceRef.current?.pause(), []);
  useEffect(() => {
    if (!on) silenceRef.current?.pause();
  }, [on]);

  const title = track?.title;
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
    if (on) navigator.mediaSession.playbackState = isPaused ? 'paused' : 'playing';
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
