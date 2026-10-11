'use client';

import { useCallback, useMemo } from 'react';
import { useLibrary, useNowPlaying } from '@/lib/library-context';
import { usePlayerActions } from '@/lib/spotify-player-context';
import type { NowPlayingTrack } from '@/lib/spotify/now-playing-track';
import {
  formatDuration,
  playable,
  tintFor,
  workHref,
  type LibraryWork,
  type Movement,
} from '@/lib/prelude';
import { locate, workTimeline, type WorkTimeline } from '@/lib/work-timeline';

/** A movement with audio, which the player can start from. */
type Heard = Movement & { uri: string };

/**
 * What the player shows for what's playing: the recording it belongs to
 * when we can place it, or the bare track when we can't. Either way it is
 * played as a programme of movements — an unplaced track is just a
 * programme of one.
 */
export interface Programme {
  /** The work, when the track is placed in one; null for an unplaced track. */
  work: LibraryWork | null;
  /** Stable per recording (or track), for keying what should restart with it. */
  key: string;
  /** The movements this recording plays, in order. */
  heard: Heard[];
  /** The one playing. */
  movement: Movement;
  timeline: WorkTimeline;
  tint: string;
  ink: string;
  cover: string | null;
  album: string;
  detailHref: string | null;
  /** Seek within the recording; elsewhere than the playing movement starts that one. */
  seekToRatio: (ratio: number) => void;
  /** Start the recording from one of its movements. */
  playFrom: (movement: Movement) => void;
}

/**
 * The one movement an unplaced track is. Its name is Spotify's title, so it
 * is marked unnamed: nothing here came from MusicBrainz.
 */
function unplacedMovement(track: NowPlayingTrack, liked: boolean): Heard {
  return {
    n: 1,
    position: 1,
    roman: '',
    name: track.name,
    unnamed: true,
    missing: false,
    durationMs: track.durationMs,
    duration: formatDuration(track.durationMs),
    liked,
    trackId: track.id,
    uri: track.uri,
  };
}

export function useProgramme(): Programme | null {
  const nowPlaying = useNowPlaying();
  const { likedTrackIds } = useLibrary();
  const { play, seek } = usePlayerActions();

  const shape = useMemo(() => {
    if (!nowPlaying) return null;
    if (nowPlaying.kind === 'placed') {
      const { work, movement } = nowPlaying;
      const heard: Heard[] = playable(work.movements);
      return {
        work,
        key: work.id,
        heard,
        movement,
        timeline: workTimeline(heard, movement.trackId),
        tint: work.tint,
        ink: work.ink,
        cover: work.cover,
        album: work.album,
        detailHref: workHref(work),
      };
    }
    const { track } = nowPlaying;
    const movement = unplacedMovement(track, track.id !== null && likedTrackIds.has(track.id));
    const { tint, ink } = tintFor(track.albumId ?? track.uri);
    return {
      work: null,
      key: `track:${track.uri}`,
      heard: [movement],
      movement,
      timeline: workTimeline([movement], movement.trackId),
      tint,
      ink,
      cover: track.cover,
      album: track.albumName,
      detailHref: null,
    };
  }, [nowPlaying, likedTrackIds]);

  const seekToRatio = useCallback(
    (ratio: number) => {
      if (!shape) return;
      const at = locate(shape.timeline, ratio);
      if (!at) return;
      if (at.index === shape.timeline.index) {
        seek(at.offsetMs);
      } else {
        play(shape.heard.slice(at.index).map((m) => m.uri)).then(() => seek(at.offsetMs));
      }
    },
    [shape, play, seek],
  );

  const playFrom = useCallback(
    (movement: Movement) => {
      if (!shape) return;
      const at = shape.heard.findIndex((m) => m.n === movement.n);
      if (at >= 0) play(shape.heard.slice(at).map((m) => m.uri));
    },
    [shape, play],
  );

  return useMemo(
    () => (shape ? { ...shape, seekToRatio, playFrom } : null),
    [shape, seekToRatio, playFrom],
  );
}
