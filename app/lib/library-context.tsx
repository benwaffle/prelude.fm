'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createSpotifySdk } from '@/lib/spotify-sdk';
import { useLikedSongs } from '@/lib/use-liked-songs';
import { useServerQuery } from '@/lib/use-server-query';
import { usePlayer } from '@/lib/spotify-player-context';
import type { NowPlayingTrack } from '@/lib/spotify/now-playing-track';
import { getMusicBrainzLibrary } from '@/app/actions/library-mb';
import type { UnresolvedLibraryTrack } from '@/lib/musicbrainz-library';
import type { MusicBrainzLibrary } from '@/lib/musicbrainz-library-view';
import { withLiveLikes, type LibraryWork, type Movement } from '@/lib/prelude';

const spotifyClientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? '';

interface Placement {
  work: LibraryWork;
  movement: Movement;
}

interface LibraryContextValue {
  /** Works with at least one saved movement. */
  works: LibraryWork[];
  /**
   * Held tracks the MusicBrainz reader cannot put on a card, each with what
   * is missing. Empty under the reader in production, which reports a track
   * it cannot place only as absent.
   */
  gapTracks: UnresolvedLibraryTrack[];
  likedTrackIds: Set<string>;
  /** No library to show yet. A stale cache counts as a library. */
  loading: boolean;
  /** Spotify is being re-read behind a library we're already showing. */
  refreshing: boolean;
  matching: boolean;
  /** Spotify would not hand over the liked songs. */
  error: string | null;
  /** We hold the liked songs but could not match them to works. */
  matchFailure: { message: string; retry: () => void } | null;
  totalSaved: number;
  toggleLike: (trackId: string) => void;
  /**
   * A recording a page is showing that the library may not hold, so the
   * player can still say which work it is playing. Never shown in the library.
   */
  rememberWork: (work: LibraryWork) => void;
  /** Which work and movement each track belongs to, as far as we know. */
  placements: Map<string, Placement>;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function LibraryProvider({
  accessToken,
  userId,
  children,
}: {
  accessToken: string;
  userId: string;
  children: ReactNode;
}) {
  const { tracks, loading, refreshing, error, total } = useLikedSongs(accessToken, userId);
  const [known, setKnown] = useState<Map<string, LibraryWork>>(new Map());
  // Optimistic overrides so a heart responds before Spotify confirms.
  const [pendingLikes, setPendingLikes] = useState<Map<string, boolean>>(new Map());

  const likedTrackIds = useMemo(() => {
    const next = new Set(tracks.map((t) => t.track.id));
    for (const [trackId, liked] of pendingLikes) {
      if (liked) next.add(trackId);
      else next.delete(trackId);
    }
    return next;
  }, [tracks, pendingLikes]);

  /* Resolve saved tracks into works as soon as we hold a whole library — a
     stale cache included, so an hour-old page still shows its works while
     Spotify is re-read. Keyed on `loading` so a first, progressive load is
     resolved once, not once per page; keyed on one snapshot of the library
     (its size and its ends) so each snapshot is resolved once. */
  const snapshot =
    loading || tracks.length === 0
      ? ''
      : `${tracks.length}:${tracks[0].track.id}:${tracks[tracks.length - 1].track.id}`;
  const match = useServerQuery(
    snapshot
      ? () =>
          getMusicBrainzLibrary(
            tracks.map((t) => t.track.id),
            tracks.map((t) => [t.track.id, t.added_at] as [string, string]),
          )
      : null,
    [snapshot],
  );

  // Keep showing the last matched library while a newer snapshot is matched.
  const [matched, setMatched] = useState<MusicBrainzLibrary | null>(null);
  if (match.status === 'ready' && match.data !== matched) setMatched(match.data);

  const works = useMemo(
    () =>
      (matched?.works ?? []).map((w) => ({
        ...w,
        movements: withLiveLikes(w.movements, likedTrackIds),
      })),
    [matched, likedTrackIds],
  );

  /** Built once per library, not searched on every render of the player. */
  const placements = useMemo(() => {
    const byTrack = new Map<string, Placement>();
    const place = (work: LibraryWork) => {
      for (const movement of work.movements) {
        if (movement.trackId && !byTrack.has(movement.trackId)) {
          byTrack.set(movement.trackId, { work, movement });
        }
      }
    };
    // The library's own card wins over a page's copy of the same recording.
    works.forEach(place);
    for (const work of known.values()) {
      place({ ...work, movements: withLiveLikes(work.movements, likedTrackIds) });
    }
    return byTrack;
  }, [works, known, likedTrackIds]);

  const toggleLike = useCallback(
    (trackId: string) => {
      const nextLiked = !likedTrackIds.has(trackId);
      setPendingLikes((prev) => new Map(prev).set(trackId, nextLiked));

      const spotify = createSpotifySdk(accessToken, spotifyClientId);
      const request = nextLiked
        ? spotify.currentUser.tracks.saveTracks([trackId])
        : spotify.currentUser.tracks.removeSavedTracks([trackId]);

      request.catch((err) => {
        console.error('Failed to update liked track:', err);
        // Put the heart back where it was.
        setPendingLikes((prev) => {
          const next = new Map(prev);
          next.delete(trackId);
          return next;
        });
      });
    },
    [accessToken, likedTrackIds],
  );

  const rememberWork = useCallback((work: LibraryWork) => {
    setKnown((prev) => (prev.has(work.id) ? prev : new Map(prev).set(work.id, work)));
  }, []);

  const failedWith = match.status === 'error' ? match.message : null;
  const retryMatch = match.status === 'error' ? match.retry : null;
  const matchFailure = useMemo(
    () => (failedWith !== null && retryMatch ? { message: failedWith, retry: retryMatch } : null),
    [failedWith, retryMatch],
  );

  const value = useMemo<LibraryContextValue>(
    () => ({
      works,
      gapTracks: matched?.unresolvedTracks ?? [],
      likedTrackIds,
      loading,
      refreshing,
      matching: snapshot !== '' && match.status === 'loading',
      error,
      matchFailure,
      totalSaved: total,
      toggleLike,
      rememberWork,
      placements,
    }),
    [
      works,
      matched,
      likedTrackIds,
      loading,
      refreshing,
      snapshot,
      match.status,
      error,
      matchFailure,
      total,
      toggleLike,
      rememberWork,
      placements,
    ],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used inside a LibraryProvider');
  return ctx;
}

/**
 * What is playing, placed in its work when we know the work: the library's
 * cards first, then any recording a page has shown. A track we can't place
 * is still playing, and is said to be unplaced rather than dressed as a work.
 */
export type NowPlaying =
  | { kind: 'placed'; work: LibraryWork; movement: Movement }
  | { kind: 'unplaced'; track: NowPlayingTrack }
  | null;

export function useNowPlaying(): NowPlaying {
  const { currentTrack } = usePlayer();
  const { placements } = useLibrary();
  return useMemo(() => {
    if (!currentTrack) return null;
    const placed = currentTrack.id ? placements.get(currentTrack.id) : undefined;
    return placed ? { kind: 'placed', ...placed } : { kind: 'unplaced', track: currentTrack };
  }, [currentTrack, placements]);
}
