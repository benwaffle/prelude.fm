'use client';

import Image from 'next/image';
import type { Track } from '@spotify/web-api-ts-sdk';
import { useSpotifyPlayer } from '@/lib/spotify-player-context';

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

interface MovementRowProps {
  track: Track;
  displayName?: string;
  hideComposer?: string;
  hideArtwork?: boolean;
  isPlaying?: boolean;
  queueTracks?: Track[];
}

export function MovementRow({
  track,
  displayName,
  hideComposer,
  hideArtwork,
  isPlaying,
  queueTracks = [],
}: MovementRowProps) {
  const { play } = useSpotifyPlayer();

  const artists = hideComposer
    ? track.artists.filter((a) => a.name !== hideComposer)
    : track.artists;

  const artistNames = artists.map((a) => a.name).join(', ');
  const showArtists = !hideArtwork;
  const showAlbum = !hideArtwork;
  const shouldShowLine = (showArtists && artistNames.length > 0) || showAlbum;

  return (
    <button
      onClick={() => play([track.uri, ...queueTracks.map((t) => t.uri)])}
      className={`w-full flex items-center gap-3 text-left cursor-pointer transition-all duration-200 group ${
        hideArtwork ? 'px-3 py-1.5' : 'border px-4 py-3'
      }`}
      style={{
        background: isPlaying ? 'rgba(139, 43, 56, 0.05)' : hideArtwork ? 'transparent' : 'var(--warm-white)',
        borderColor: hideArtwork ? 'transparent' : isPlaying ? 'var(--accent)' : 'var(--border)',
      }}
      onMouseEnter={(e) => {
        if (!hideArtwork) {
          e.currentTarget.style.borderColor = 'var(--accent)';
        }
        e.currentTarget.style.background = isPlaying ? 'rgba(139, 43, 56, 0.08)' : 'rgba(139, 43, 56, 0.02)';
      }}
      onMouseLeave={(e) => {
        if (!hideArtwork) {
          e.currentTarget.style.borderColor = isPlaying ? 'var(--accent)' : 'var(--border)';
        }
        e.currentTarget.style.background = isPlaying ? 'rgba(139, 43, 56, 0.05)' : hideArtwork ? 'transparent' : 'var(--warm-white)';
      }}
    >
      {!hideArtwork && track.album.images[0] && (
        <div className="shrink-0 overflow-hidden" style={{ borderRadius: '2px' }}>
          <Image
            src={track.album.images[0].url}
            alt={track.album.name}
            width={44}
            height={44}
            className="transition-transform duration-300 group-hover:scale-105"
          />
        </div>
      )}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate" style={{ color: isPlaying ? 'var(--accent)' : 'var(--charcoal)' }}>
            {displayName ?? track.name}
          </p>
          {shouldShowLine && (
            <p className="text-xs truncate" style={{ color: 'var(--warm-gray)', fontSize: '0.65rem' }}>
              {showArtists ? artistNames : ''}
              {showAlbum && (
                <>
                  {showArtists && artistNames ? ' · ' : ''}
                  {track.album.name}
                </>
              )}
            </p>
          )}
        </div>
        <span className="text-xs tabular-nums shrink-0" style={{ color: 'var(--warm-gray)', fontSize: '0.65rem' }}>
          {formatDuration(track.duration_ms)}
        </span>
      </div>
      {isPlaying && (
        <div className="shrink-0 flex items-center gap-px">
          <div className="w-0.5 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent)', animationDelay: '0s' }} />
          <div className="w-0.5 h-2.5 rounded-full animate-pulse" style={{ background: 'var(--accent)', animationDelay: '0.15s' }} />
          <div className="w-0.5 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent)', animationDelay: '0.3s' }} />
        </div>
      )}
    </button>
  );
}
