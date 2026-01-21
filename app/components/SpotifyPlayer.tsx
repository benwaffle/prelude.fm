'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import Image from 'next/image';
import { useSpotifyPlayer } from '@/lib/spotify-player-context';

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function SpotifyPlayer() {
  const {
    isReady,
    isPaused,
    currentTrack,
    volume,
    togglePlay,
    previousTrack,
    nextTrack,
    seek,
    setVolume,
    getProgress,
  } = useSpotifyPlayer();

  // Refs for imperative progress updates
  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressContainerRef = useRef<HTMLDivElement>(null);
  const currentTimeRef = useRef<HTMLSpanElement>(null);
  const durationRef = useRef<HTMLSpanElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Update progress bar imperatively via requestAnimationFrame
  const updateProgress = useCallback(() => {
    if (isDragging) return; // Don't update while dragging
    const progress = getProgress();
    if (progressBarRef.current) {
      const percent = progress.duration > 0 ? (progress.position / progress.duration) * 100 : 0;
      progressBarRef.current.style.width = `${percent}%`;
    }
    if (currentTimeRef.current) {
      currentTimeRef.current.textContent = formatTime(progress.position);
    }
    if (durationRef.current) {
      durationRef.current.textContent = formatTime(progress.duration);
    }
  }, [getProgress, isDragging]);

  useEffect(() => {
    let animationId: number;
    const tick = () => {
      updateProgress();
      animationId = requestAnimationFrame(tick);
    };
    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, [updateProgress]);

  // Scrubbing logic
  const handleSeek = useCallback(
    (clientX: number) => {
      if (!progressContainerRef.current) return;
      const rect = progressContainerRef.current.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const progress = getProgress();
      const newPosition = percent * progress.duration;

      // Update UI immediately
      if (progressBarRef.current) {
        progressBarRef.current.style.width = `${percent * 100}%`;
      }
      if (currentTimeRef.current) {
        currentTimeRef.current.textContent = formatTime(newPosition);
      }

      return newPosition;
    },
    [getProgress],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsDragging(true);
      handleSeek(e.clientX);
    },
    [handleSeek],
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      handleSeek(e.clientX);
    };

    const handleMouseUp = (e: MouseEvent) => {
      const newPosition = handleSeek(e.clientX);
      if (newPosition !== undefined) {
        seek(newPosition);
      }
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleSeek, seek]);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setVolume(parseFloat(e.target.value));
  };

  return (
    <div
      className="fixed bottom-0 left-0 right-0 backdrop-blur-xl border-t px-6 py-4"
      style={{
        background: 'rgba(250, 247, 242, 0.95)',
        borderColor: 'var(--border-strong)',
        boxShadow: '0 -4px 20px rgba(26, 22, 20, 0.06)',
      }}
    >
      <div className="mx-auto flex items-center gap-6 max-w-[1600px]">
        {/* Track info */}
        <div className="flex items-center justify-start gap-4 flex-1 min-w-0">
          {currentTrack ? (
            <>
              {currentTrack.album?.images?.[0]?.url && (
                <div className="shrink-0 overflow-hidden shadow-md" style={{ borderRadius: '2px' }}>
                  <Image
                    src={currentTrack.album.images[0].url}
                    alt={currentTrack.album?.name || 'Album'}
                    width={56}
                    height={56}
                  />
                </div>
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--charcoal)' }}>
                  {currentTrack.name}
                </p>
                <p className="text-xs truncate" style={{ color: 'var(--warm-gray)' }}>
                  {currentTrack.artists?.map((a) => a.name).join(', ')}
                </p>
              </div>
            </>
          ) : (
            <p className="text-sm" style={{ color: 'var(--warm-gray)' }}>
              {isReady ? 'Select a track' : 'Connecting...'}
            </p>
          )}
        </div>

        {/* Playback controls */}
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-3">
            {/* Previous */}
            <button
              onClick={previousTrack}
              disabled={!isReady || !currentTrack}
              className="w-9 h-9 flex items-center justify-center transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              style={{ color: 'var(--charcoal)' }}
              onMouseEnter={(e) => !e.currentTarget.disabled && (e.currentTarget.style.color = 'var(--accent)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--charcoal)')}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M4 4a1 1 0 011 1v4.586l6.293-6.293a1 1 0 011.414 0l.707.707a1 1 0 010 1.414L7.414 10l6 6a1 1 0 010 1.414l-.707.707a1 1 0 01-1.414 0L4 11.414V16a1 1 0 01-2 0V4a1 1 0 011-1z" />
              </svg>
            </button>

            {/* Play/Pause */}
            <button
              onClick={togglePlay}
              disabled={!isReady || !currentTrack}
              className="w-11 h-11 flex items-center justify-center rounded-full transition-all duration-300 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shadow-sm"
              style={{
                background: 'var(--accent)',
                color: 'var(--cream)',
              }}
              onMouseEnter={(e) => {
                if (!e.currentTarget.disabled) {
                  e.currentTarget.style.background = 'var(--accent-hover)';
                  e.currentTarget.style.transform = 'scale(1.05)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--accent)';
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              {isPaused ? (
                <svg className="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M5.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75A.75.75 0 007.25 3h-1.5zM12.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75a.75.75 0 00-.75-.75h-1.5z" />
                </svg>
              )}
            </button>

            {/* Next */}
            <button
              onClick={nextTrack}
              disabled={!isReady || !currentTrack}
              className="w-9 h-9 flex items-center justify-center transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              style={{ color: 'var(--charcoal)' }}
              onMouseEnter={(e) => !e.currentTarget.disabled && (e.currentTarget.style.color = 'var(--accent)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--charcoal)')}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M16 4a1 1 0 00-1 1v4.586L8.707 3.293a1 1 0 00-1.414 0l-.707.707a1 1 0 000 1.414L12.586 10l-6 6a1 1 0 000 1.414l.707.707a1 1 0 001.414 0L16 11.414V16a1 1 0 002 0V4a1 1 0 00-1-1z" />
              </svg>
            </button>
          </div>

          {/* Progress bar */}
          <div className="w-[500px] flex items-center gap-3 mt-1">
            <span
              ref={currentTimeRef}
              className="text-xs w-10 text-right tabular-nums font-medium"
              style={{ color: 'var(--warm-gray)' }}
            >
              0:00
            </span>
            <div
              ref={progressContainerRef}
              onMouseDown={handleMouseDown}
              className="flex-1 h-1.5 rounded-full cursor-pointer group relative"
              style={{ background: 'var(--light-gray)' }}
            >
              <div
                ref={progressBarRef}
                className="h-full rounded-full transition-all duration-150 relative"
                style={{ width: '0%', background: 'var(--accent)' }}
              >
                <div
                  className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-sm"
                  style={{ background: 'var(--accent)' }}
                />
              </div>
            </div>
            <span
              ref={durationRef}
              className="text-xs w-10 tabular-nums font-medium"
              style={{ color: 'var(--warm-gray)' }}
            >
              0:00
            </span>
          </div>
        </div>

        {/* Volume control */}
        <div className="flex-1 flex items-center justify-end gap-3">
          <button
            onClick={() => setVolume(volume === 0 ? 0.5 : 0)}
            className="w-8 h-8 flex items-center justify-center cursor-pointer transition-colors duration-200"
            style={{ color: 'var(--warm-gray)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--charcoal)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--warm-gray)')}
          >
            {volume === 0 ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z" />
              </svg>
            ) : volume < 0.5 ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" />
              </svg>
            )}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={handleVolumeChange}
            className="w-24 h-1 rounded-full appearance-none cursor-pointer"
            style={{
              background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${volume * 100}%, var(--light-gray) ${volume * 100}%, var(--light-gray) 100%)`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
