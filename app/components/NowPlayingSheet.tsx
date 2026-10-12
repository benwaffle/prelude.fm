'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePlayer } from '@/lib/spotify-player-context';
import { useLibrary } from '@/lib/library-context';
import { hexToRgba, numeralPrefix } from '@/lib/prelude';
import { Icon } from './Icon';
import { QueueList } from './queue/QueueList';
import { Credit } from './player/Credit';
import { MovementName } from './work/WorkText';
import { MovementList } from './work/MovementList';
import { useProgramme } from './player/use-programme';
import { WorkProgress } from './player/WorkProgress';
import { PlayerCover, TransportButtons } from './player/TransportButtons';

// Rendered into <body>: the player bar's backdrop blur would otherwise trap a fixed-position child
// inside the bar.
export function NowPlayingSheet({
  onClose,
  onChooseDevice,
}: {
  onClose: () => void;
  onChooseDevice: () => void;
}) {
  const { isPaused, outputDevice } = usePlayer();
  const { toggleLike } = useLibrary();
  const programme = useProgramme();
  const [leaving, setLeaving] = useState(false);
  const close = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [close]);

  if (!programme) return null;

  const { movement } = programme;
  const remote = outputDevice && !outputDevice.isThisBrowser;
  const title = (
    <>
      {movement.roman && (
        <span className="mr-2 italic opacity-70">{numeralPrefix(movement.roman)}</span>
      )}
      <MovementName movement={movement} />
    </>
  );

  return createPortal(
    <div
      role="dialog"
      aria-label="Now playing"
      onAnimationEnd={(e) => {
        if (leaving && e.target === e.currentTarget) onClose();
      }}
      className={`fixed inset-0 z-[40] flex flex-col overflow-y-auto overscroll-contain select-none ${
        leaving ? 'animate-sheet-out' : 'animate-sheet-in'
      }`}
      style={{
        background: `linear-gradient(180deg, ${hexToRgba(programme.tint, 0.97)}, ${hexToRgba(programme.tint, 1)} 60%), #111`,
        color: programme.ink,
      }}
    >
      <div className="flex items-center justify-between px-4 pt-[calc(10px+env(safe-area-inset-top))] pb-2">
        <button
          type="button"
          onClick={close}
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
          <PlayerCover
            key={programme.key}
            programme={programme}
            className="h-full w-full object-cover"
            fallbackClassName="h-full w-full text-[72px]"
          />
        </div>

        <div className="mt-6 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {programme.detailHref ? (
              <Link
                href={programme.detailHref}
                onClick={close}
                className="block font-display text-[22px] leading-[1.2] no-underline"
              >
                {title}
              </Link>
            ) : (
              <div className="font-display text-[22px] leading-[1.2]">{title}</div>
            )}
            <div className="mt-1 font-display text-[15px] italic opacity-75">
              <Credit programme={programme} linked onNavigate={close} />
            </div>
          </div>
          {movement.trackId && (
            <button
              type="button"
              onClick={() => movement.trackId && toggleLike(movement.trackId)}
              aria-label={movement.liked ? 'Remove from liked' : 'Like this movement'}
              className="-mr-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center"
            >
              <Icon name={movement.liked ? 'heartFill' : 'heartOutline'} size={22} />
            </button>
          )}
        </div>

        <div className="mt-6">
          <WorkProgress key={programme.key} programme={programme} size="sheet" />
        </div>

        <div className="mt-4">
          <TransportButtons size="sheet" tint={programme.tint} />
        </div>

        {programme.heard.length > 1 && (
          <div className="mt-8">
            <div className="mb-2 font-meta text-[10px] tracking-[0.2em] uppercase opacity-60">
              Movements
            </div>
            <MovementList
              variant="sheet"
              movements={programme.heard}
              playingTrackId={movement.trackId}
              isPaused={isPaused}
              onPlay={programme.playFrom}
            />
          </div>
        )}

        <div className="mt-8">
          <QueueList />
        </div>
      </div>
    </div>,
    document.body,
  );
}
