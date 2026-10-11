'use client';

import { usePlayer, usePlayerActions } from '@/lib/spotify-player-context';
import { hexToRgba, initialsOf } from '@/lib/prelude';
import { Icon } from '../Icon';
import { CoverArt } from '../work/CoverArt';
import type { Programme } from './use-programme';

const PLAY_SIZES = {
  mini: { button: 'h-11 w-11 shrink-0', icon: 18 },
  bar: { button: 'h-10 w-10 transition-transform duration-150 hover:scale-105', icon: 18 },
  sheet: { button: 'h-[68px] w-[68px] transition-transform active:scale-95', icon: 28 },
} as const;

/** Play or pause, a disc in the bar's ink with the icon cut out in its tint. */
export function PlayButton({ size, tint }: { size: keyof typeof PLAY_SIZES; tint: string }) {
  const { isPaused, isReady } = usePlayer();
  const { togglePlay } = usePlayerActions();
  const { button, icon } = PLAY_SIZES[size];
  return (
    <button
      type="button"
      title={isPaused ? 'Play' : 'Pause'}
      aria-label={isPaused ? 'Play' : 'Pause'}
      onClick={togglePlay}
      disabled={!isReady}
      className={`flex cursor-pointer items-center justify-center rounded-full bg-current disabled:cursor-default disabled:opacity-35 ${button}`}
    >
      <span key={isPaused ? 'play' : 'pause'} className="flex animate-pop" style={{ color: tint }}>
        <Icon name={isPaused ? 'play' : 'pause'} size={icon} />
      </span>
    </button>
  );
}

/** Previous movement, play or pause, next movement. */
export function TransportButtons({ size, tint }: { size: 'bar' | 'sheet'; tint: string }) {
  const { isReady } = usePlayer();
  const { previousTrack, nextTrack } = usePlayerActions();
  const sheet = size === 'sheet';
  const step = sheet
    ? 'flex h-12 w-12 cursor-pointer items-center justify-center disabled:opacity-35'
    : 'cursor-pointer opacity-85 hover:opacity-100 disabled:cursor-default disabled:opacity-35';
  return (
    <div className={`flex items-center justify-center ${sheet ? 'gap-10' : 'gap-[18px]'}`}>
      <button
        type="button"
        title="Previous movement"
        aria-label="Previous movement"
        onClick={previousTrack}
        disabled={!isReady}
        className={step}
      >
        <Icon name="prev" size={sheet ? 26 : 20} />
      </button>
      <PlayButton size={size} tint={tint} />
      <button
        type="button"
        title="Next movement"
        aria-label="Next movement"
        onClick={nextTrack}
        disabled={!isReady}
        className={step}
      >
        <Icon name="next" size={sheet ? 26 : 20} />
      </button>
    </div>
  );
}

/**
 * The cover in the player, or the composer's initials on the bar's ink when
 * there is no art (none at all when the composer is unknown too).
 */
export function PlayerCover({
  programme,
  className,
  fallbackClassName,
}: {
  programme: Programme;
  className: string;
  fallbackClassName: string;
}) {
  const composer = programme.work?.composerFull;
  return (
    <CoverArt src={programme.cover} alt={programme.album} className={className}>
      <div
        className={`flex items-center justify-center font-display ${fallbackClassName}`}
        style={{ background: hexToRgba(programme.ink, 0.14) }}
      >
        {composer ? initialsOf(composer) : ''}
      </div>
    </CoverArt>
  );
}
