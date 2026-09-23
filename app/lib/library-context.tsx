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
import { createSpotifySdk } from '@/lib/spotify-sdk';
import { useLikedSongs } from '@/lib/use-liked-songs';
import { getMusicBrainzLibrary } from '@/app/actions/library-mb';
import type { UnresolvedLibraryTrack } from '@/lib/musicbrainz-library';
import type { LibraryWork, Movement } from '@/lib/prelude';

const spotifyClientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? '';

interface LibraryContextValue {
  /** Works with at least one saved movement, plus any registered by a page. */
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
  error: string | null;
  totalSaved: number;
  toggleLike: (trackId: string) => void;
  /** Lets the detail screen contribute a recording the library doesn't hold. */
  registerWorks: (works: LibraryWork[]) => void;
  /** Which work and movement a playing track belongs to, if we know. */
  locate: (trackId: string | null | undefined) => { work: LibraryWork; movement: Movement } | null;
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
  const [works, setWorks] = useState<LibraryWork[]>([]);
  const [gapTracks, setGapTracks] = useState<UnresolvedLibraryTrack[]>([]);
  const [extra, setExtra] = useState<LibraryWork[]>([]);
  // Optimistic overrides so a heart responds before Spotify confirms.
  const [pendingLikes, setPendingLikes] = useState<Map<string, boolean>>(new Map());
  const requestedFor = useRef<string>('');
  const [resolvedFor, setResolvedFor] = useState('');

  const savedIds = useMemo(() => new Set(tracks.map((t) => t.track.id)), [tracks]);

  /** Identifies one snapshot of the saved library, so we resolve it once. */
  const signature = useMemo(() => {
    if (tracks.length === 0) return '';
    return `${tracks.length}:${tracks[0].track.id}:${tracks[tracks.length - 1].track.id}`;
  }, [tracks]);

  const matching = !loading && tracks.length > 0 && resolvedFor !== signature;

  const likedTrackIds = useMemo(() => {
    const next = new Set(savedIds);
    for (const [trackId, liked] of pendingLikes) {
      if (liked) next.add(trackId);
      else next.delete(trackId);
    }
    return next;
  }, [savedIds, pendingLikes]);

  /* Resolve saved tracks into works as soon as we hold a whole library —
     a stale cache included, so an hour-old page still shows its works while
     Spotify is re-read. Gated on `loading` only to avoid firing once per page
     of a first, progressive load. */
  useEffect(() => {
    const key = signature;
    if (loading || signature === '' || requestedFor.current === key) return;
    requestedFor.current = key;

    let cancelled = false;
    const ids = tracks.map((t) => t.track.id);
    const resolving = getMusicBrainzLibrary(
      ids,
      tracks.map((t) => [t.track.id, t.added_at] as [string, string]),
    );

    resolving
      .then((resolved) => {
        if (cancelled) return;
        setWorks(resolved.works);
        setGapTracks(resolved.unresolvedTracks);
      })
      .catch((err) => console.error('Failed to resolve library works:', err))
      .finally(() => {
        // Either way this snapshot has been dealt with; stop showing a spinner.
        if (!cancelled) setResolvedFor(signature);
      });
    return () => {
      cancelled = true;
    };
  }, [tracks, loading, signature]);

  const addedAtByTrack = useMemo(
    () => new Map(tracks.map((t) => [t.track.id, t.added_at])),
    [tracks],
  );

  // Re-read `liked` off the live set so hearts stay in sync after a toggle,
  // and date each work by the most recently saved movement in it.
  const decorated = useMemo(() => {
    const merged = [...works];
    const seen = new Set(works.map((w) => w.id));
    for (const w of extra) if (!seen.has(w.id)) merged.push(w);

    return merged.map((w) => {
      const movements = w.movements.map((m) => ({
        ...m,
        liked: m.trackId !== null && likedTrackIds.has(m.trackId),
      }));
      let addedAt: string | null = null;
      for (const m of movements) {
        if (!m.liked || m.trackId === null) continue;
        const at = addedAtByTrack.get(m.trackId);
        if (at && (addedAt === null || at > addedAt)) addedAt = at;
      }
      return { ...w, movements, addedAt };
    });
  }, [works, extra, likedTrackIds, addedAtByTrack]);

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

  const registerWorks = useCallback((incoming: LibraryWork[]) => {
    setExtra((prev) => {
      const known = new Set(prev.map((w) => w.id));
      const additions = incoming.filter((w) => !known.has(w.id));
      return additions.length === 0 ? prev : [...prev, ...additions];
    });
  }, []);

  const locate = useCallback(
    (trackId: string | null | undefined) => {
      if (!trackId) return null;
      for (const work of decorated) {
        const movement = work.movements.find((m) => m.trackId === trackId);
        if (movement) return { work, movement };
      }
      return null;
    },
    [decorated],
  );

  const value: LibraryContextValue = {
    works: decorated,
    gapTracks,
    likedTrackIds,
    loading,
    refreshing,
    matching,
    error,
    totalSaved: total,
    toggleLike,
    registerWorks,
    locate,
  };

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used inside a LibraryProvider');
  return ctx;
}
