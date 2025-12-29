"use client";

import { useEffect, useState, useRef } from "react";
import Image from "next/image";
import { getMatchedTracks, type MatchedTrack } from "../actions/spotify";

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

interface SpotifyLikedSongsPage {
  items: LikedTrack[];
  next: string | null;
  total: number;
}

interface LikedSongsProps {
  accessToken: string;
  onPlayTrack: (track: Track) => void;
  currentTrack: Track | null;
}

export function LikedSongs({ accessToken, onPlayTrack, currentTrack }: LikedSongsProps) {
  const [tracks, setTracks] = useState<LikedTrack[]>([]);
  const [matchedTracks, setMatchedTracks] = useState<MatchedTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingMatches, setCheckingMatches] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [unmatchedCollapsed, setUnmatchedCollapsed] = useState(true);
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
          db.createObjectStore("likedSongs", { keyPath: "track.id" });

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

        const metadata = await new Promise<{ timestamp: number; total: number } | null>((resolve) => {
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

    async function checkMatches(allTracks: LikedTrack[]) {
      setCheckingMatches(true);
      try {
        const trackIds = allTracks.map((t) => t.track.id);
        const matched = await getMatchedTracks(trackIds);
        setMatchedTracks(matched);
      } catch (err) {
        console.error("Failed to check matches:", err);
      } finally {
        setCheckingMatches(false);
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
          checkMatches(cached);
          return;
        }

        let url: string | null = "https://api.spotify.com/v1/me/tracks?limit=50";
        const allTracks: LikedTrack[] = [];

        while (url) {
          const response: Response = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!response.ok) {
            throw new Error("Failed to fetch liked songs");
          }
          const data: SpotifyLikedSongsPage = await response.json();
          allTracks.push(...data.items);
          setTracks([...allTracks]);
          setTotal(data.total);
          url = data.next;
        }

        // Cache the results
        await setCache(allTracks, allTracks.length);

        // Check which tracks are matched
        checkMatches(allTracks);
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setLoading(false);
      }
    }

    fetchAllLikedSongs();
  }, [accessToken]);

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

  // Convert number to roman numeral
  const toRoman = (num: number): string => {
    const romanNumerals: [number, string][] = [
      [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]
    ];
    let result = "";
    for (const [value, symbol] of romanNumerals) {
      while (num >= value) {
        result += symbol;
        num -= value;
      }
    }
    return result;
  };

  // Create maps of trackId -> work info, movement number, and movement name
  const trackWorkMap = new Map(matchedTracks.map((m) => [m.trackId, m.work]));
  const trackMovementMap = new Map(matchedTracks.map((m) => [m.trackId, m.movementNumber]));
  const trackMovementNameMap = new Map(matchedTracks.map((m) => [
    m.trackId,
    m.movementName ? `${toRoman(m.movementNumber)}. ${m.movementName}` : `${toRoman(m.movementNumber)}.`
  ]));
  const matchedTrackIds = new Set(matchedTracks.map((m) => m.trackId));

  // Group matched tracks by work
  const matchedByWork = new Map<number, { work: MatchedTrack["work"]; tracks: LikedTrack[] }>();
  for (const likedTrack of sortedTracks) {
    const work = trackWorkMap.get(likedTrack.track.id);
    if (work) {
      const existing = matchedByWork.get(work.id);
      if (existing) {
        existing.tracks.push(likedTrack);
      } else {
        matchedByWork.set(work.id, { work, tracks: [likedTrack] });
      }
    }
  }

  const unmatchedTracksList = sortedTracks.filter((t) => !matchedTrackIds.has(t.track.id));

  const TrackRow = ({
    track,
    displayName,
    hideComposer,
    hideArtwork,
    isPlaying,
  }: {
    track: Track;
    displayName?: string;
    hideComposer?: string;
    hideArtwork?: boolean;
    isPlaying?: boolean;
  }) => {
    const artists = hideComposer
      ? track.artists.filter((a) => a.name !== hideComposer)
      : track.artists;

    return (
      <button
        onClick={() => onPlayTrack(track)}
        className={`w-full flex items-center gap-3 p-2 text-left cursor-pointer ${
          hideArtwork ? "" : "rounded"
        } ${
          isPlaying
            ? "bg-green-100 dark:bg-green-900/30 hover:bg-green-200 dark:hover:bg-green-900/40"
            : "bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800"
        }`}
      >
        {!hideArtwork && track.album.images[0] && (
          <Image
            src={track.album.images[0].url}
            alt={track.album.name}
            width={40}
            height={40}
            className="rounded"
          />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-black dark:text-zinc-50 truncate">
            {displayName ?? track.name}
          </p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
            {artists.length > 0 ? `${artists.map((a) => a.name).join(", ")} • ` : ""}{track.album.name}
          </p>
        </div>
      </button>
    );
  };

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
            {sortOrder === "desc" ? "Newest First" : "Oldest First"}
          </button>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {loading ? `Loading ${tracks.length} of ${total}...` : `${tracks.length} songs`}
          </p>
        </div>
      </div>

      {/* Matched tracks section - grouped by work */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Matched
          </h3>
          <span className="text-xs text-zinc-500">
            {checkingMatches ? "..." : `${matchedTrackIds.size} tracks, ${matchedByWork.size} works`}
          </span>
        </div>
        <div className="space-y-1">
          {Array.from(matchedByWork.values()).map(({ work, tracks: workTracks }) => {
            if (workTracks.length === 1) {
              // Single-track work - compact view with styled text
              const { track } = workTracks[0];
              const movementDisplay = trackMovementNameMap.get(track.id);
              const artists = track.artists.filter((a) => a.name !== work.composerName);
              const isPlaying = currentTrack?.id === track.id;
              return (
                <button
                  key={work.id}
                  onClick={() => onPlayTrack(track)}
                  className={`w-full flex items-center gap-3 p-2 rounded text-left cursor-pointer ${
                    isPlaying
                      ? "bg-green-100 dark:bg-green-900/30 hover:bg-green-200 dark:hover:bg-green-900/40"
                      : "bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                  }`}
                >
                  {track.album.images[0] && (
                    <Image
                      src={track.album.images[0].url}
                      alt={track.album.name}
                      width={40}
                      height={40}
                      className="rounded"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-black dark:text-zinc-50 truncate">
                      <span className="font-medium">{work.composerName}</span>
                      <span className="text-zinc-400 mx-1.5">&middot;</span>
                      <span>{work.title}</span>
                      {work.nickname && <span className="text-zinc-500"> &ldquo;{work.nickname}&rdquo;</span>}
                      {work.catalogSystem && work.catalogNumber && (
                        <span className="text-zinc-500">, {work.catalogSystem} {work.catalogNumber}</span>
                      )}
                      {movementDisplay && (
                        <>
                          <span className="text-zinc-400 mx-1.5">&middot;</span>
                          <span>{movementDisplay}</span>
                        </>
                      )}
                    </p>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
                      {artists.length > 0 ? `${artists.map((a) => a.name).join(", ")} • ` : ""}{track.album.name}
                    </p>
                  </div>
                </button>
              );
            }

            // Multi-track work - with header
            const firstTrack = workTracks[0].track;
            return (
              <div key={work.id} className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden my-3">
                <div className="px-3 py-2 bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-3">
                  {firstTrack.album.images[0] && (
                    <Image
                      src={firstTrack.album.images[0].url}
                      alt={firstTrack.album.name}
                      width={48}
                      height={48}
                      className="rounded"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-black dark:text-zinc-100 truncate">
                      <span className="font-medium">{work.composerName}</span>
                      <span className="text-zinc-400 mx-1.5">&middot;</span>
                      <span>{work.title}</span>
                      {work.nickname && <span className="text-zinc-500"> &ldquo;{work.nickname}&rdquo;</span>}
                      {work.catalogSystem && work.catalogNumber && (
                        <span className="text-zinc-500">, {work.catalogSystem} {work.catalogNumber}</span>
                      )}
                    </p>
                    <p className="text-xs text-zinc-500 truncate">{firstTrack.album.name}</p>
                  </div>
                </div>
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {[...workTracks]
                    .sort((a, b) => {
                      const movA = trackMovementMap.get(a.track.id) ?? 0;
                      const movB = trackMovementMap.get(b.track.id) ?? 0;
                      return movA - movB;
                    })
                    .map(({ track }) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        displayName={trackMovementNameMap.get(track.id) ?? undefined}
                        hideComposer={work.composerName}
                        hideArtwork
                        isPlaying={currentTrack?.id === track.id}
                      />
                    ))}
                </div>
              </div>
            );
          })}
          {!checkingMatches && matchedByWork.size === 0 && (
            <p className="text-sm text-zinc-500 py-4">
              No matched tracks yet
            </p>
          )}
        </div>
      </div>

      {/* Unmatched tracks section */}
      <div className="pb-24">
        <button
          onClick={() => setUnmatchedCollapsed(!unmatchedCollapsed)}
          className="flex items-center gap-2 mb-2 cursor-pointer"
        >
          <span className="text-sm text-zinc-500">
            {unmatchedCollapsed ? "▶" : "▼"}
          </span>
          <h3 className="text-sm font-medium text-zinc-500">
            Unmatched
          </h3>
          <span className="text-xs text-zinc-500">
            {checkingMatches ? "..." : unmatchedTracksList.length}
          </span>
        </button>
        {!unmatchedCollapsed && (
          <div className="space-y-1">
            {unmatchedTracksList.map(({ track }) => (
              <TrackRow key={track.id} track={track} isPlaying={currentTrack?.id === track.id} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
