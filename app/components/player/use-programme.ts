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

type Heard = Movement & { uri: string };

export interface Programme {
  work: LibraryWork | null;
  key: string;
  heard: Heard[];
  movement: Movement;
  timeline: WorkTimeline;
  tint: string;
  ink: string;
  cover: string | null;
  album: string;
  detailHref: string | null;
  seekToRatio: (ratio: number) => void;
  playFrom: (movement: Movement) => void;
}

/** Its name is Spotify's title, so it is marked unnamed: nothing here came from MusicBrainz. */
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
