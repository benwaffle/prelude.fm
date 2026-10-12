'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { usePlayer, usePlayerActions } from '@/lib/spotify-player-context';
import { useLibrary } from '@/lib/library-context';
import { hexToRgba, numeralPrefix, workByline } from '@/lib/prelude';
import { useMediaSession } from '@/lib/use-media-session';
import { Icon } from './Icon';
import { DevicePicker } from './DevicePicker';
import { QueuePanel } from './queue/QueuePanel';
import { NowPlayingSheet } from './NowPlayingSheet';
import { MovementName } from './work/WorkText';
import { Credit } from './player/Credit';
import { useProgramme, type Programme } from './player/use-programme';
import { ProgressLine, WorkProgress } from './player/WorkProgress';
import { PlayButton, PlayerCover, TransportButtons } from './player/TransportButtons';

const IDLE_TINT = '#2a1f2e';
const IDLE_INK = '#f4ecd8';

export function PlayerBar() {
  const { isReady, isPaused, volume, outputDevice, local, playbackError, needsDevice, queue } =
    usePlayer();
  const {
    togglePlay,
    previousTrack,
    nextTrack,
    seek,
    setVolume,
    getProgress,
    subscribeToProgress,
    dismissDevicePrompt,
    playQueue,
  } = usePlayerActions();
  const { toggleLike } = useLibrary();
  const programme = useProgramme();

  const [pickerOpen, setPickerOpen] = useState(false);
  const showPicker = pickerOpen || needsDevice;
  const closePicker = useCallback(() => {
    setPickerOpen(false);
    dismissDevicePrompt();
  }, [dismissDevicePrompt]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const chooseDeviceFromSheet = useCallback(() => {
    setSheetOpen(false);
    setPickerOpen(true);
  }, []);
  const [queueOpen, setQueueOpen] = useState(false);
  const closeQueue = useCallback(() => setQueueOpen(false), []);

  const remote = outputDevice && !outputDevice.isThisBrowser ? outputDevice : null;
  const work = programme?.work ?? null;
  const movement = programme?.movement ?? null;
  useMediaSession({
    active: !remote,
    track:
      programme && movement
        ? {
            title: [numeralPrefix(movement.roman), movement.name].filter(Boolean).join(' '),
            artist: work ? (workByline(work) ?? '') : '',
            album: work ? (work.title ?? work.album) : programme.album,
            cover: programme.cover,
          }
        : null,
    isPaused,
    onTogglePlay: togglePlay,
    onPrevious: previousTrack,
    onNext: nextTrack,
    onSeek: seek,
    getProgress,
    subscribeToProgress,
  });

  const handleVolume = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setVolume(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    },
    [setVolume],
  );

  const tint = programme?.tint ?? IDLE_TINT;
  const toggleDevicePicker = () => (showPicker ? closePicker() : setPickerOpen(true));

  return (
    <div
      className="relative grid grid-cols-[360px_minmax(0,1fr)_320px] items-center border-t border-black/20 px-7 py-[14px] backdrop-blur-[14px] max-[900px]:block max-[900px]:px-3 max-[900px]:py-2"
      style={{
        background: `linear-gradient(180deg, ${hexToRgba(tint, 0.82)}, ${hexToRgba(tint, 0.98)})`,
        color: programme?.ink ?? IDLE_INK,
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/5 to-black/[0.12]" />

      {showPicker && <DevicePicker onClose={closePicker} />}
      {queueOpen && programme && <QueuePanel onClose={closeQueue} />}

      {playbackError && (
        <div className="absolute right-0 bottom-full left-0 z-[2] bg-accent px-7 py-[6px] text-center font-display text-[13px] text-paper italic max-[900px]:px-4">
          {playbackError}
        </div>
      )}

      {!programme || !movement ? (
        <div className="relative z-[1] col-span-full flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center font-display text-[13px] italic">
          <span className="opacity-75">
            {isReady
              ? remote
                ? `Choose a movement to play on ${remote.name}.`
                : 'Choose a movement to begin.'
              : local.status === 'unavailable'
                ? local.problem
                : 'Connecting to Spotify…'}
          </span>
          {isReady && queue.length > 0 && (
            <button
              type="button"
              onClick={playQueue}
              className="flex cursor-pointer items-center gap-[6px] border-b border-current pb-px font-meta text-[10px] tracking-[0.16em] not-italic uppercase opacity-85 hover:opacity-100"
            >
              <Icon name="play" size={10} />
              Play queue ({queue.length})
            </button>
          )}
          {(isReady || local.status === 'unavailable') && (
            <button
              type="button"
              data-device-toggle
              onClick={toggleDevicePicker}
              className="flex cursor-pointer items-center gap-[6px] border-b border-current pb-px font-meta text-[10px] tracking-[0.16em] not-italic uppercase opacity-85 hover:opacity-100"
            >
              <Icon name="devices" size={13} />
              {isReady ? 'Change device' : 'Play on another device'}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="relative z-[1] animate-rise min-[901px]:hidden">
            <ProgressLine programme={programme} />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                aria-label="Open the player"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
              >
                <BarCover key={programme.key} programme={programme} />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline font-display text-[15px] leading-[1.25]">
                    {movement.roman && (
                      <span className="mr-[6px] shrink-0 italic opacity-70">
                        {numeralPrefix(movement.roman)}
                      </span>
                    )}
                    <MovementName movement={movement} className="truncate" />
                  </span>
                  <span className="block truncate font-display text-[12.5px] italic opacity-75">
                    {remote ? `On ${remote.name}` : <Credit programme={programme} />}
                  </span>
                </span>
              </button>
              <PlayButton size="mini" tint={tint} />
            </div>
          </div>

          {sheetOpen && (
            <NowPlayingSheet onClose={closeSheet} onChooseDevice={chooseDeviceFromSheet} />
          )}

          <div className="relative z-[1] grid min-w-0 grid-cols-[56px_1fr] items-center gap-[14px] max-[900px]:hidden">
            {programme.detailHref ? (
              <Link href={programme.detailHref} className="block shrink-0">
                <BarCover key={programme.key} programme={programme} />
              </Link>
            ) : (
              <BarCover key={programme.key} programme={programme} />
            )}
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 font-display text-[15px] leading-[1.2] max-[900px]:text-[14px]">
                {programme.detailHref ? (
                  <Link
                    href={programme.detailHref}
                    className="flex min-w-0 items-baseline border-b border-transparent no-underline transition-colors duration-150 hover:border-current"
                  >
                    {movement.roman && (
                      <span className="mr-[6px] shrink-0 italic opacity-70">
                        {numeralPrefix(movement.roman)}
                      </span>
                    )}
                    <MovementName movement={movement} className="truncate" />
                  </Link>
                ) : (
                  <span className="flex min-w-0 items-baseline">
                    <MovementName movement={movement} className="truncate" />
                  </span>
                )}
                {movement.trackId && (
                  <button
                    type="button"
                    onClick={() => movement.trackId && toggleLike(movement.trackId)}
                    title={movement.liked ? 'Remove from liked' : 'Like this movement'}
                    className="flex shrink-0 cursor-pointer opacity-55 transition-all duration-150 hover:scale-110 hover:opacity-100"
                  >
                    <Icon name={movement.liked ? 'heartFill' : 'heartOutline'} size={12} />
                  </button>
                )}
              </div>
              <div className="truncate font-display text-[11.5px] italic opacity-75">
                <Credit programme={programme} linked />
              </div>
            </div>
          </div>

          <div className="relative z-[1] flex flex-col items-center gap-2 max-[900px]:hidden">
            <TransportButtons size="bar" tint={tint} />

            <div className="flex w-[min(560px,100%)] flex-col gap-1 max-[900px]:w-full">
              <SeamLabels programme={programme} />
              <WorkProgress key={programme.key} programme={programme} size="bar" />
            </div>
          </div>

          <div className="relative z-[1] flex min-w-0 items-center justify-end gap-[14px] max-[900px]:hidden">
            <button
              type="button"
              title={outputDevice ? `Playing on ${outputDevice.name}` : 'Choose where to play'}
              data-device-toggle
              onClick={toggleDevicePicker}
              className={`flex min-w-0 cursor-pointer items-center gap-[6px] hover:opacity-100 ${
                remote ? 'opacity-100' : 'opacity-70'
              }`}
            >
              <span className="shrink-0">
                <Icon name="devices" size={16} />
              </span>
              {remote && (
                <span className="max-w-[140px] truncate font-meta text-[10.5px] tracking-[0.04em] max-[900px]:max-w-[90px]">
                  {remote.name}
                </span>
              )}
            </button>
            <button
              type="button"
              title="Queue"
              data-queue-toggle
              onClick={() => setQueueOpen((open) => !open)}
              className={`relative cursor-pointer hover:opacity-100 max-[900px]:hidden ${
                queueOpen ? 'opacity-100' : 'opacity-70'
              }`}
            >
              <Icon name="queue" size={16} />
              {queue.length > 0 && (
                <span
                  key={queue.length}
                  className="absolute -top-[7px] -right-[9px] flex h-[14px] min-w-[14px] animate-pop items-center justify-center rounded-full bg-current px-[3px] font-meta text-[9px] leading-none tabular-nums"
                >
                  <span style={{ color: tint }}>{queue.length}</span>
                </span>
              )}
            </button>
            {/* Some Connect devices, iPhones among them, keep volume to themselves. */}
            {outputDevice?.supportsVolume !== false && (
              <div className="flex items-center gap-2 max-[900px]:hidden">
                <button
                  type="button"
                  title={volume === 0 ? 'Unmute' : 'Mute'}
                  onClick={() => setVolume(volume === 0 ? 0.6 : 0)}
                  className="cursor-pointer opacity-70 hover:opacity-100"
                >
                  <Icon name={volume === 0 ? 'mute' : 'vol'} size={16} />
                </button>
                <div
                  onClick={handleVolume}
                  className="relative h-1 w-[90px] cursor-pointer rounded-[2px] bg-white/15"
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-[2px] bg-current"
                    style={{ width: `${volume * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function BarCover({ programme }: { programme: Programme }) {
  return (
    <PlayerCover
      programme={programme}
      className="h-14 w-14 animate-rise rounded-[2px] object-cover shadow-[0_10px_30px_-10px_rgba(0,0,0,0.8)] max-[900px]:h-11 max-[900px]:w-11"
      fallbackClassName="h-14 w-14 animate-rise rounded-[2px] text-lg max-[900px]:h-11 max-[900px]:w-11"
    />
  );
}

function SeamLabels({ programme }: { programme: Programme }) {
  const { heard, movement, timeline } = programme;
  return (
    <div className="relative flex font-meta text-[9px] tracking-[0.14em] uppercase opacity-65 max-[900px]:hidden">
      {heard.map((m, i) => (
        <span
          key={m.n}
          className={`truncate border-l border-current pr-[6px] pl-[5px] first:border-l-0 first:pl-0 ${
            m.n === movement.n ? 'font-semibold opacity-100' : ''
          }`}
          style={{
            width: `${(timeline.durations[i] / timeline.totalMs) * 100}%`,
            opacity: m.liked ? 1 : 0.45,
          }}
        >
          {m.liked && <span className="mr-1">♥</span>}
          {numeralPrefix(m.roman)} {m.name.length > 12 ? `${m.name.slice(0, 12)}…` : m.name}
        </span>
      ))}
    </div>
  );
}
