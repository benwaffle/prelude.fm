"use client";

import { useEffect, useState, useRef } from "react";
import Image from "next/image";
import type { SavedTrack, SimplifiedArtist } from "@spotify/web-api-ts-sdk";
import { getMatchedTracks, submitToMatchQueue, type MatchedTrack } from "../actions/spotify";
import { useSpotifyPlayer } from "@/lib/spotify-player-context";
import { useLikedSongs } from "@/lib/use-liked-songs";
import { MovementRow } from "./MovementRow";

interface LikedSongsProps {
  accessToken: string;
}

export function LikedSongs({ accessToken }: LikedSongsProps) {
  const { currentTrack, play } = useSpotifyPlayer();
  const { tracks, loading, error, total } = useLikedSongs(accessToken);
  const [matchedTracks, setMatchedTracks] = useState<MatchedTrack[]>([]);
  const [checkingMatches, setCheckingMatches] = useState(false);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [unmatchedCollapsed, setUnmatchedCollapsed] = useState(true);
  const hasCheckedMatches = useRef(false);

  // Check matches when tracks are loaded
  useEffect(() => {
    if (tracks.length === 0 || hasCheckedMatches.current) return;
    hasCheckedMatches.current = true;

    async function checkMatches() {
      setCheckingMatches(true);
      try {
        const trackIds = tracks.map((t) => t.track.id);
        const matched = await getMatchedTracks(trackIds);
        setMatchedTracks(matched);

        // Submit unmatched tracks to the queue
        const matchedIds = new Set(matched.map((m) => m.trackId));
        const unmatchedIds = trackIds.filter((id) => !matchedIds.has(id));
        if (unmatchedIds.length > 0) {
          const result = await submitToMatchQueue(unmatchedIds);
          if (result.submitted > 0) {
            console.log(`Submitted ${result.submitted} tracks to match queue`);
          }
        }
      } catch (err) {
        console.error("Failed to check matches:", err);
      } finally {
        setCheckingMatches(false);
      }
    }

    checkMatches();
  }, [tracks]);

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
  const matchedByWork = new Map<number, { work: MatchedTrack["work"]; tracks: SavedTrack[] }>();
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

  return (
    <div className="w-full">
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
        <div className="divide-y divide-zinc-200 dark:divide-zinc-700 md:divide-y-0 md:grid md:grid-cols-[minmax(0,_1fr)_max-content] md:border md:border-zinc-200 md:dark:border-zinc-700">
          {Array.from(matchedByWork.values()).map(({ work, tracks: workTracks }) => {
            const firstTrack = workTracks[0].track;
            const headerArtists = Array.from(
              new Set(
                firstTrack.artists
                  .filter((a: SimplifiedArtist) => a.name !== work.composerName)
                  .map((a: SimplifiedArtist) => a.name)
              )
            );

            // Sort tracks by movement number for playback
            const sortedWorkTracks = [...workTracks].sort((a, b) => {
              const movA = trackMovementMap.get(a.track.id) ?? 0;
              const movB = trackMovementMap.get(b.track.id) ?? 0;
              return movA - movB;
            });
            const workUris = sortedWorkTracks.map(({ track }) => track.uri);

            return (
              <div key={work.id} className="contents">
                <button
                  onClick={() => play(workUris)}
                  className="px-3 py-3 flex items-center gap-3 border-b border-zinc-200 dark:border-zinc-700 md:border-b md:border-r md:pr-10 text-left cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
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
                    <p className="text-xs text-zinc-500 truncate">
                      {headerArtists.join(", ")}
                      {firstTrack.album.name && (
                        <>
                          {headerArtists.length ? " • " : ""}
                          {firstTrack.album.name}
                        </>
                      )}
                    </p>
                  </div>
                </button>
                <div className="divide-y divide-zinc-200 dark:divide-zinc-700 border-b border-zinc-200 dark:border-zinc-700 md:border-b md:border-l">
                  {[...workTracks]
                      .sort((a, b) => {
                        const movA = trackMovementMap.get(a.track.id) ?? 0;
                        const movB = trackMovementMap.get(b.track.id) ?? 0;
                        return movA - movB;
                      })
                      .map(({ track }, index, sortedArray) => {
                        // Get all subsequent tracks after this one
                        const queueTracks = sortedArray.slice(index + 1).map(item => item.track);

                        return (
                          <MovementRow
                            key={track.id}
                            track={track}
                            displayName={trackMovementNameMap.get(track.id) ?? undefined}
                            hideComposer={work.composerName}
                            hideArtwork
                            isPlaying={currentTrack?.id === track.id}
                            queueTracks={queueTracks}
                          />
                        );
                      })}
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
              <MovementRow key={track.id} track={track} isPlaying={currentTrack?.id === track.id} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
