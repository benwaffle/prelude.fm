'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import type { MaxInt, SavedTrack } from '@spotify/web-api-ts-sdk';
import { createSpotifySdk } from '@/lib/spotify-sdk';
import { getCachedLikedSongs, setCachedLikedSongs } from './liked-songs-cache';

const spotifyClientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? '';

interface UseLikedSongsResult {
  tracks: SavedTrack[];
  loading: boolean;
  error: string | null;
  total: number;
  refetch: () => Promise<void>;
}

export function useLikedSongs(accessToken: string): UseLikedSongsResult {
  const [tracks, setTracks] = useState<SavedTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const hasFetched = useRef(false);

  const fetchFromApi = useCallback(async () => {
    const spotify = createSpotifySdk(accessToken, spotifyClientId);
    const limit = 50 as MaxInt<50>;
    const allTracks: SavedTrack[] = [];
    let offset = 0;
    let hasNext = true;

    while (hasNext) {
      const page = await spotify.currentUser.tracks.savedTracks(limit, offset);
      allTracks.push(...page.items);
      setTracks([...allTracks]);
      setTotal(page.total);
      hasNext = Boolean(page.next);
      offset += page.items.length;
      if (page.items.length === 0) break;
    }

    await setCachedLikedSongs(allTracks);
    return allTracks;
  }, [accessToken]);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const cached = await getCachedLikedSongs();
      if (cached && cached.length > 0) {
        setTracks(cached);
        setTotal(cached.length);
        setLoading(false);
        return;
      }

      await fetchFromApi();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [fetchFromApi]);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await fetchFromApi();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [fetchFromApi]);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    fetch();
  }, [fetch]);

  return { tracks, loading, error, total, refetch };
}
