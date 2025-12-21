"use client";

import { useEffect, useState } from "react";

interface Track {
  id: string;
  name: string;
  artists: { name: string }[];
  album: {
    name: string;
    images: { url: string }[];
  };
}

interface LikedTrack {
  track: Track;
}

export function LikedSongs() {
  const [tracks, setTracks] = useState<LikedTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    async function fetchAllLikedSongs() {
      try {
        let url: string | null = "https://api.spotify.com/v1/me/tracks?limit=50";

        while (url) {
          const response = await fetch(
            `/api/spotify/liked-songs?url=${encodeURIComponent(url)}`
          );
          if (!response.ok) {
            throw new Error("Failed to fetch liked songs");
          }
          const data = await response.json();
          setTracks((prev) => [...prev, ...data.items]); // Use functional update
          setTotal(data.total);
          url = data.next;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setLoading(false);
      }
    }

    fetchAllLikedSongs();
  }, []);

  if (loading && tracks.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-zinc-600 dark:text-zinc-400">
          Loading your liked songs...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-red-600 dark:text-red-400">Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-black dark:text-zinc-50">
          Your Liked Songs
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {loading ? `Loading ${tracks.length} of ${total}...` : `${tracks.length} songs`}
        </p>
      </div>
      <div className="space-y-1">
        {tracks.map(({ track }) => (
          <div
            key={track.id}
            className="flex items-center gap-3 p-2 rounded bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors"
          >
            {track.album.images[0] && (
              <img
                src={track.album.images[0].url}
                alt={track.album.name}
                className="w-10 h-10 rounded"
              />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-black dark:text-zinc-50 truncate">
                {track.name}
              </p>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
                {track.artists.map((a) => a.name).join(", ")} • {track.album.name}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
