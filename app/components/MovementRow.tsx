"use client";

import Image from "next/image";
import type { Track } from "@spotify/web-api-ts-sdk";
import { useSpotifyPlayer } from "@/lib/spotify-player-context";

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

interface MovementRowProps {
  track: Track;
  displayName?: string;
  hideComposer?: string;
  hideArtwork?: boolean;
  isPlaying?: boolean;
}

export function MovementRow({
  track,
  displayName,
  hideComposer,
  hideArtwork,
  isPlaying,
}: MovementRowProps) {
  const { play } = useSpotifyPlayer();

  const artists = hideComposer
    ? track.artists.filter((a) => a.name !== hideComposer)
    : track.artists;

  const artistNames = artists.map((a) => a.name).join(", ");
  const showArtists = !hideArtwork;
  const showAlbum = !hideArtwork;
  const shouldShowLine = (showArtists && artistNames.length > 0) || showAlbum;

  return (
    <button
      onClick={() => play([track.uri])}
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
        <p className="text-sm font-semibold text-black dark:text-zinc-50 truncate flex items-center gap-2">
          <span className="truncate">{displayName ?? track.name}</span>
          <span className="text-xs text-zinc-500">{formatDuration(track.duration_ms)}</span>
        </p>
        {shouldShowLine && (
          <p className="text-xs text-zinc-600 dark:text-zinc-400 truncate">
            {showArtists ? artistNames : ""}
            {showAlbum && (
              <>
                {showArtists && artistNames ? " • " : ""}
                {track.album.name}
              </>
            )}
          </p>
        )}
      </div>
    </button>
  );
}
