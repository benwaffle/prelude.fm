'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { PlaybackDevice } from '@/lib/spotify-player-context';
import { hexToRgba, numeralPrefix, type LibraryWork, type Movement } from '@/lib/prelude';
import { Icon, Waveform } from './Icon';

interface NowPlayingSheetProps {
  work: LibraryWork;
  movement: Movement;
  /** The movements this recording actually plays, in order. */
  heard: Movement[];
  durations: number[];
  totalMs: number;
  isPaused: boolean;
  isReady: boolean;
  detailHref: string | null;
  outputDevice: PlaybackDevice | null;
  onClose: () => void;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onScrub: (e: React.MouseEvent<HTMLElement>) => void;
  onPlayFrom: (index: number) => void;
  onToggleLike: (trackId: string) => void;
  onChooseDevice: () => void;
}

/**
 * The phone player, full screen: the cover, the work, transport big enough
 * for a thumb, and the recording's movements to jump between. The bar it
 * opens from stays a single row so it doesn't eat the screen.
 *
 * Rendered into <body>: the player bar's backdrop blur would otherwise trap a
 * fixed-position child inside the bar.
 */
export function NowPlayingSheet({
  work,
  movement,
  heard,
  durations,
  totalMs,
  isPaused,
  isReady,
  detailHref,
  outputDevice,
  onClose,
  onTogglePlay,
  onPrevious,
  onNext,
  onScrub,
  onPlayFrom,
  onToggleLike,
  onChooseDevice,
}: NowPlayingSheetProps) {
  // The page underneath shouldn't scroll while the sheet covers it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const ink = work.ink;
  const remote = outputDevice && !outputDevice.isThisBrowser;

  return createPortal(
    <div
      role="dialog"
      aria-label="Now playing"
      className="fixed inset-0 z-[40] flex flex-col overflow-y-auto overscroll-contain select-none"
      style={{
        background: `linear-gradient(180deg, ${hexToRgba(work.tint, 0.97)}, ${hexToRgba(work.tint, 1)} 60%), #111`,
        color: ink,
      }}
    >
      <div className="flex items-center justify-between px-4 pt-[calc(10px+env(safe-area-inset-top))] pb-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the player"
          className="-ml-2 flex h-11 w-11 cursor-pointer items-center justify-center opacity-85"
        >
          <span className="-rotate-90">
            <Icon name="back" size={22} />
          </span>
        </button>
        <span className="font-meta text-[10px] tracking-[0.2em] uppercase opacity-70">
          {remote ? `Playing on ${outputDevice.name}` : 'Now playing'}
        </span>
        <button
          type="button"
          onClick={onChooseDevice}
          aria-label="Choose where to play"
          className={`-mr-2 flex h-11 w-11 cursor-pointer items-center justify-center ${remote ? 'opacity-100' : 'opacity-75'}`}
        >
          <Icon name="devices" size={20} />
        </button>
      </div>

      <div className="flex flex-col px-6 pb-[calc(24px+env(safe-area-inset-bottom))]">
        <div className="mx-auto mt-2 aspect-square w-full max-w-[min(340px,38vh)] overflow-hidden rounded-[3px] shadow-[0_30px_60px_-20px_rgba(0,0,0,0.7)]">
          {work.cover ? (
            // eslint-disable-next-line @next/next/no-img-element -- same raw asset as the bar
            <img src={work.cover} alt={work.album} className="h-full w-full object-cover" />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center font-display text-[72px]"
              style={{ background: hexToRgba(ink, 0.12) }}
            >
              {work.composer?.slice(0, 1) ?? ''}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-display text-[22px] leading-[1.2]">
              {movement.roman && (
                <span className="mr-2 italic opacity-70">{numeralPrefix(movement.roman)}</span>
              )}
              {movement.name}
            </div>
            <div className="mt-1 font-display text-[15px] italic opacity-75">
              {work.composerFull ?? (!work.title && 'Work unmatched')}
              {work.title && (
                <>
                  {work.composerFull && ' · '}
                  {detailHref ? (
                    <Link href={detailHref} onClick={onClose} className="underline-offset-2">
                      {work.title}
                    </Link>
                  ) : (
                    work.title
                  )}
                </>
              )}
              {work.nickname && <> “{work.nickname}”</>}
            </div>
          </div>
          {movement.trackId && (
            <button
              type="button"
              onClick={() => movement.trackId && onToggleLike(movement.trackId)}
              aria-label={movement.liked ? 'Remove from liked' : 'Like this movement'}
              className="-mr-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center"
            >
              <Icon name={movement.liked ? 'heartFill' : 'heartOutline'} size={22} />
            </button>
          )}
        </div>

        {/* Work-scoped progress, one seam per movement, like the desktop bar. */}
        <div className="mt-6">
          <div
            onClick={onScrub}
            className="relative h-[5px] cursor-pointer rounded-[3px] bg-white/20 before:absolute before:-inset-y-4 before:inset-x-0 before:content-['']"
          >
            <div
              data-progress="fill"
              className="absolute inset-y-0 left-0 rounded-[3px] bg-current"
            />
            {heard.slice(0, -1).map((m, i) => {
              const at = durations.slice(0, i + 1).reduce((a, b) => a + b, 0);
              return (
                <div
                  key={m.n}
                  className="absolute -top-[3px] -bottom-[3px] w-px bg-white/40"
                  style={{ left: `${(at / totalMs) * 100}%` }}
                />
              );
            })}
            <div
              data-progress="head"
              className="absolute top-1/2 h-[13px] w-[13px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current"
            />
          </div>
          <div className="mt-2 flex justify-between font-meta text-[11px] tabular-nums opacity-70">
            <span data-progress="elapsed">0:00</span>
            <span data-progress="remaining" />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-center gap-10">
          <button
            type="button"
            onClick={onPrevious}
            disabled={!isReady}
            aria-label="Previous movement"
            className="flex h-12 w-12 cursor-pointer items-center justify-center disabled:opacity-35"
          >
            <Icon name="prev" size={26} />
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={!isReady}
            aria-label={isPaused ? 'Play' : 'Pause'}
            className="flex h-[68px] w-[68px] cursor-pointer items-center justify-center rounded-full bg-current transition-transform active:scale-95 disabled:opacity-35"
          >
            <span className="flex" style={{ color: work.tint }}>
              <Icon name={isPaused ? 'play' : 'pause'} size={28} />
            </span>
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!isReady}
            aria-label="Next movement"
            className="flex h-12 w-12 cursor-pointer items-center justify-center disabled:opacity-35"
          >
            <Icon name="next" size={26} />
          </button>
        </div>

        {heard.length > 1 && (
          <div className="mt-8">
            <div className="mb-2 font-meta text-[10px] tracking-[0.2em] uppercase opacity-60">
              Movements
            </div>
            <ol className="m-0 list-none border-t border-white/15 p-0">
              {heard.map((m, i) => {
                const current = m.trackId === movement.trackId;
                return (
                  <li key={m.n} className="border-b border-white/15">
                    <button
                      type="button"
                      onClick={() => onPlayFrom(i)}
                      className="grid w-full cursor-pointer grid-cols-[30px_minmax(0,1fr)_auto] items-baseline gap-3 py-3 text-left"
                    >
                      <span className="text-right font-display text-[14px] italic opacity-70">
                        {numeralPrefix(m.roman)}
                      </span>
                      <span
                        className={`flex min-w-0 items-baseline gap-2 font-display text-[16px] ${current ? '' : 'opacity-80'}`}
                      >
                        <span className="truncate">{m.name}</span>
                        {current && !isPaused && <Waveform />}
                      </span>
                      <span className="font-meta text-[11px] tabular-nums opacity-65">
                        {m.liked && <span className="mr-2">♥</span>}
                        {m.duration}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
