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
import type { SavedTrack } from '@spotify/web-api-ts-sdk';
import { createSpotifySdk } from '@/lib/spotify-sdk';
import { useLikedSongs } from '@/lib/use-liked-songs';
import { getLibraryWorks } from '@/app/actions/library';
import { getMusicBrainzLibrary } from '@/app/actions/library-mb';
import { getKnownComposerArtists, submitToMatchQueue } from '@/app/actions/spotify';
import { useReaderChoice, type ReaderChoice } from '@/lib/reader-choice';
import type { UnresolvedLibraryTrack } from '@/lib/musicbrainz-library';
import type { LibraryWork, Movement } from '@/lib/prelude';

const spotifyClientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? '';

export interface UnmatchedTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: string;
  uri: string;
}

interface LibraryContextValue {
  /** Works with at least one saved movement, plus any registered by a page. */
  works: LibraryWork[];
  unmatched: UnmatchedTrack[];
  /** Which reader drew `works`, so a screen can say so and offer the other. */
  reader: ReaderChoice;
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

function formatMs(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function LibraryProvider({
  accessToken,
  userId,
  children,
}: {
  accessToken: string;
  userId: string;
  children: ReactNode;
}) {
  const reader = useReaderChoice();
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
    const key = `${reader}:${signature}`;
    if (loading || signature === '' || requestedFor.current === key) return;
    requestedFor.current = key;

    let cancelled = false;
    const ids = tracks.map((t) => t.track.id);
    const resolving =
      reader === 'musicbrainz'
        ? getMusicBrainzLibrary(
            ids,
            tracks.map((t) => [t.track.id, t.added_at] as [string, string]),
          )
        : getLibraryWorks(ids).then((resolved) => ({ works: resolved, unresolvedTracks: [] }));

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
  }, [tracks, loading, signature, reader]);

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

  // Saved tracks we could not place in a work — the escape hatch at the
  // bottom of the library.
  const unmatched = useMemo(() => {
    const placed = new Set<string>();
    for (const w of works) for (const m of w.movements) if (m.trackId) placed.add(m.trackId);
    return tracks
      .filter(({ track }) => !placed.has(track.id))
      .map(({ track }: SavedTrack) => ({
        id: track.id,
        title: track.name,
        artist: track.artists.map((a) => a.name).join(', '),
        album: track.album.name,
        duration: formatMs(track.duration_ms),
        uri: track.uri,
      }));
  }, [tracks, works]);

  /*
   * Anything we couldn't place but whose artists include a composer we know
   * is almost certainly classical, so hand it to the matcher unprompted. The
   * rest waits for the user to submit it from the unmatched strip.
   */
  const submittedFor = useRef('');
  useEffect(() => {
    if (matching || works.length === 0 || unmatched.length === 0) return;
    const key = unmatched.map((t) => t.id).join(',');
    if (submittedFor.current === key) return;
    submittedFor.current = key;

    let cancelled = false;
    const byId = new Map(tracks.map((t) => [t.track.id, t.track]));
    const artistIds = new Set<string>();
    for (const t of unmatched) {
      for (const artist of byId.get(t.id)?.artists ?? []) artistIds.add(artist.id);
    }
    if (artistIds.size === 0) return;

    getKnownComposerArtists(Array.from(artistIds))
      .then((known) => {
        if (cancelled || known.length === 0) return;
        const composerArtists = new Set(known.map((c) => c.artistId));
        const eligible = unmatched
          .filter((t) => byId.get(t.id)?.artists.some((a) => composerArtists.has(a.id)))
          .map((t) => t.id);
        if (eligible.length > 0) return submitToMatchQueue(eligible);
      })
      .catch((err) => console.error('Failed to queue unmatched tracks:', err));

    return () => {
      cancelled = true;
    };
  }, [matching, works, unmatched, tracks]);

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
    unmatched,
    reader,
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
