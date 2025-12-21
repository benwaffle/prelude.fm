"use client";

import { useEffect, useState, useRef } from "react";

interface Track {
  id: string;
  name: string;
  artists: { name: string }[];
  album: {
    name: string;
    images: { url: string }[];
  };
  uri: string;
}

interface LikedTrack {
  track: Track;
  added_at: string;
}

interface LikedSongsProps {
  onPlayTrack: (track: Track) => void;
}

export function LikedSongs({ onPlayTrack }: LikedSongsProps) {
  const [tracks, setTracks] = useState<LikedTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const hasFetched = useRef(false);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;

    async function openDB() {
      return new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("SpotifyCache", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;

          // Clear old store if exists
          if (db.objectStoreNames.contains("likedSongs")) {
            db.deleteObjectStore("likedSongs");
          }

          // Create new store with track.id as key
          const store = db.createObjectStore("likedSongs", { keyPath: "track.id" });

          // Create metadata store
          if (!db.objectStoreNames.contains("metadata")) {
            db.createObjectStore("metadata");
          }
        };
      });
    }

    async function getCached() {
      try {
        const db = await openDB();

        // Check if cache is fresh
        const metaTx = db.transaction("metadata", "readonly");
        const metaStore = metaTx.objectStore("metadata");
        const metaRequest = metaStore.get("lastFetch");

        const metadata = await new Promise<any>((resolve) => {
          metaRequest.onsuccess = () => resolve(metaRequest.result);
          metaRequest.onerror = () => resolve(null);
        });

        if (!metadata) return null;

        const oneHour = 60 * 60 * 1000;
        if (Date.now() - metadata.timestamp >= oneHour) return null;

        // Load all tracks
        const tx = db.transaction("likedSongs", "readonly");
        const store = tx.objectStore("likedSongs");
        const request = store.getAll();

        return new Promise<LikedTrack[]>((resolve) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve([]);
        });
      } catch {
        return null;
      }
    }

    async function setCache(tracks: LikedTrack[], total: number) {
      try {
        const db = await openDB();
        const tx = db.transaction(["likedSongs", "metadata"], "readwrite");
        const store = tx.objectStore("likedSongs");
        const metaStore = tx.objectStore("metadata");

        // Clear existing tracks
        await store.clear();

        // Add all tracks
        for (const track of tracks) {
          store.put(track);
        }

        // Store metadata
        metaStore.put({ timestamp: Date.now(), total }, "lastFetch");
      } catch (e) {
        console.error("Failed to cache:", e);
      }
    }

    async function fetchAllLikedSongs() {
      try {
        // Try to load from cache first
        const cached = await getCached();
        if (cached && cached.length > 0) {
          setTracks(cached);
          setTotal(cached.length);
          setLoading(false);
          return;
        }

        let url: string | null = "https://api.spotify.com/v1/me/tracks?limit=50";
        const allTracks: LikedTrack[] = [];

        while (url) {
          const response = await fetch(
            `/api/spotify/liked-songs?url=${encodeURIComponent(url)}`
          );
          if (!response.ok) {
            throw new Error("Failed to fetch liked songs");
          }
          const data = await response.json();
          allTracks.push(...data.items);
          setTracks([...allTracks]);
          setTotal(data.total);
          url = data.next;
        }

        // Cache the results
        await setCache(allTracks, allTracks.length);
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

  const sortedTracks = [...tracks].sort((a, b) => {
    const dateA = new Date(a.added_at).getTime();
    const dateB = new Date(b.added_at).getTime();
    return sortOrder === "desc" ? dateB - dateA : dateA - dateB;
  });

  return (
    <div className="w-full max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-black dark:text-zinc-50">
          Your Liked Songs
        </h2>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setSortOrder(sortOrder === "desc" ? "asc" : "desc")}
            className="text-sm text-zinc-600 dark:text-zinc-400 hover:text-black dark:hover:text-zinc-50 transition-colors cursor-pointer"
          >
            Date Added: {sortOrder === "desc" ? "Newest First" : "Oldest First"}
          </button>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {loading ? `Loading ${tracks.length} of ${total}...` : `${tracks.length} songs`}
          </p>
        </div>
      </div>
      <div className="space-y-1 pb-24">
        {sortedTracks.map(({ track }) => (
          <button
            key={track.id}
            onClick={() => onPlayTrack(track)}
            className="w-full flex items-center gap-3 p-2 rounded bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-left cursor-pointer"
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
          </button>
        ))}
      </div>
    </div>
  );
}
