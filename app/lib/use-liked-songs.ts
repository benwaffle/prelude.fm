'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import type { MaxInt, SavedTrack } from '@spotify/web-api-ts-sdk';
import { createSpotifySdk } from '@/lib/spotify-sdk';
import { getCachedLikedSongs, setCachedLikedSongs } from './liked-songs-cache';

const spotifyClientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? '';

interface UseLikedSongsResult {
  tracks: SavedTrack[];
  /** No library to show yet — distinct from refreshing one we already hold. */
  loading: boolean;
  /** A fetch is in flight, whether or not we're showing a cached library. */
  refreshing: boolean;
  error: string | null;
  total: number;
}

export function useLikedSongs(accessToken: string, userId: string): UseLikedSongsResult {
  const [tracks, setTracks] = useState<SavedTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const fetchedFor = useRef<string | null>(null);

  const fetchFromApi = useCallback(
    async (showProgress = true) => {
      const spotify = createSpotifySdk(accessToken, spotifyClientId);
      const limit = 50 as MaxInt<50>;
      const allTracks: SavedTrack[] = [];
      let offset = 0;
      let hasNext = true;
      let apiTotal = 0;

      while (hasNext) {
        const page = await spotify.currentUser.tracks.savedTracks(limit, offset);
        allTracks.push(...page.items);
        apiTotal = page.total;
        if (showProgress) {
          setTracks([...allTracks]);
          setTotal(page.total);
        }
        hasNext = Boolean(page.next);
        offset += page.items.length;
        if (page.items.length === 0) break;
      }

      setTracks(allTracks);
      setTotal(apiTotal);
      await setCachedLikedSongs(userId, allTracks);
      return allTracks;
    },
    [accessToken, userId],
  );

  const fetch = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    let hasCachedTracks = false;

    try {
      const cached = await getCachedLikedSongs(userId);
      if (cached) {
        hasCachedTracks = cached.tracks.length > 0;
        setTracks(cached.tracks);
        setTotal(cached.tracks.length);

        // A stale cache is still a whole library. Hand it to the app now and
        // refresh behind it, rather than sitting on a spinner for a minute.
        if (hasCachedTracks) setLoading(false);

        if (!cached.isStale) return;
      }

      await fetchFromApi(!hasCachedTracks);
    } catch (err) {
      // An expired cache is still useful. Keep showing it if a background
      // refresh fails instead of replacing the library with an error screen.
      if (hasCachedTracks) {
        console.error('Failed to refresh liked songs:', err);
      } else {
        setError(err instanceof Error ? err.message : 'An error occurred');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchFromApi, userId]);

  useEffect(() => {
    if (fetchedFor.current === userId) return;
    fetchedFor.current = userId;
    fetch();
  }, [fetch, userId]);

  return { tracks, loading, refreshing, error, total };
}
