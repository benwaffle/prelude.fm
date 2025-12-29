"use client";

import { useEffect, useState, useRef } from "react";
import Image from "next/image";
import { createSpotifySdk } from "@/lib/spotify-sdk";
import type { Track as SpotifyTrack } from "@spotify/web-api-ts-sdk";

type Track = SpotifyTrack;

const spotifyClientId = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID ?? "";

interface SpotifyPlayerProps {
  accessToken: string;
  currentTrack: Track | null;
}

interface SpotifyPlayer {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  addListener: (event: string, callback: (data: unknown) => void) => void;
  togglePlay: () => Promise<void>;
}

interface SpotifySDK {
  Player: new (config: {
    name: string;
    getOAuthToken: (cb: (token: string) => void) => void;
    volume: number;
  }) => SpotifyPlayer;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady: () => void;
    Spotify: SpotifySDK;
  }
}

export function SpotifyPlayer({ accessToken, currentTrack }: SpotifyPlayerProps) {
  const [player, setPlayer] = useState<SpotifyPlayer | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isPaused, setIsPaused] = useState(true);
  const [playbackState, setPlaybackState] = useState<{
    paused: boolean;
    position: number;
    duration: number;
    track_window?: { current_track?: Track };
  } | null>(null);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const playerRef = useRef<SpotifyPlayer | null>(null);

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);

    window.onSpotifyWebPlaybackSDKReady = () => {
      const spotifyPlayer = new window.Spotify.Player({
        name: "Classical Music Streaming",
        getOAuthToken: (cb: (token: string) => void) => {
          cb(accessToken);
        },
        volume: 0.5,
      });

      spotifyPlayer.addListener("ready", ({ device_id }: { device_id: string }) => {
        console.log("Ready with Device ID", device_id);
        setDeviceId(device_id);
        setIsReady(true);
      });

      spotifyPlayer.addListener("not_ready", ({ device_id }: { device_id: string }) => {
        console.log("Device ID has gone offline", device_id);
      });

      spotifyPlayer.addListener("player_state_changed", (state: unknown) => {
        if (!state) {
          setPlaybackState(null);
          return;
        }
        const playbackData = state as { paused: boolean; position: number; duration: number; track_window?: { current_track?: Track } };
        console.log('player_state_changed', state);
        setIsPaused(playbackData.paused);
        setPlaybackState(playbackData);
        setProgress(playbackData.position);
        setDuration(playbackData.duration);
      });

      spotifyPlayer.connect();
      setPlayer(spotifyPlayer);
      playerRef.current = spotifyPlayer;
    };

    return () => {
      if (playerRef.current) {
        playerRef.current.disconnect();
      }
    };
  }, [accessToken]);

  useEffect(() => {
    if (!currentTrack || !deviceId || !isReady) return;

    const playTrack = async () => {
      try {
        const spotify = createSpotifySdk(accessToken, spotifyClientId);
        await spotify.player.startResumePlayback(deviceId, undefined, [currentTrack.uri]);
        setIsPaused(false);
      } catch (error) {
        console.error("Error playing track:", error);
        setIsPaused(true);
      }
    };

    playTrack();
  }, [currentTrack, deviceId, isReady, accessToken]);

  // Update progress while playing (for smooth progress bar)
  useEffect(() => {
    if (isPaused || !duration) return;

    const interval = setInterval(() => {
      setProgress((prev) => {
        const newProgress = prev + 100;
        return newProgress < duration ? newProgress : duration;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [isPaused, duration]);

  const togglePlay = () => {
    if (!player) return;
    player.togglePlay();
  };

  // Show current playing track from SDK state or selected track
  const displayTrack = playbackState?.track_window?.current_track || currentTrack;

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const progressPercent = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-zinc-900 border-t border-zinc-800 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-2">
          {displayTrack ? (
            <>
              {(displayTrack.album?.images?.[0]?.url || displayTrack.album?.images?.[0]) && (
                <Image
                  src={displayTrack.album.images[0].url || displayTrack.album.images[0]}
                  alt={displayTrack.album?.name || "Album"}
                  width={56}
                  height={56}
                  className="rounded"
                />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">
                  {displayTrack.name}
                </p>
                <p className="text-xs text-zinc-400 truncate">
                  {displayTrack.artists?.map((a: { name: string }) => a.name).join(", ")}
                </p>
              </div>
              <button
                onClick={togglePlay}
                disabled={!isReady}
                className="w-10 h-10 flex items-center justify-center rounded-full bg-white text-black hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isPaused ? (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M5.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75A.75.75 0 007.25 3h-1.5zM12.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75a.75.75 0 00-.75-.75h-1.5z" />
                  </svg>
                )}
              </button>
            </>
          ) : (
            <div className="flex-1">
              <p className="text-sm text-zinc-400">
                {isReady ? "Select a track to play" : "Initializing player..."}
              </p>
            </div>
          )}
        </div>
        {displayTrack && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400 w-10 text-right">
              {formatTime(progress)}
            </span>
            <div className="flex-1 h-1 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-white transition-all duration-100"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="text-xs text-zinc-400 w-10">
              {formatTime(duration)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
