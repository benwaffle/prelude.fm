'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSpotifyPlayer } from '@/lib/spotify-player-context';
import { useLibrary } from '@/lib/library-context';
import {
  formatDuration,
  hexToRgba,
  numeralPrefix,
  playable,
  tintFor,
  type LibraryWork,
} from '@/lib/prelude';
import { Icon } from './Icon';
import { DevicePicker } from './DevicePicker';
import { NowPlayingSheet } from './NowPlayingSheet';

/**
 * The player bar, present on every screen. Progress is scoped to the whole
 * work rather than the track: the bar spans every movement of the recording,
 * with a marker at each seam.
 */
export function PlayerBar() {
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
    play,
    outputDevice,
    localStatus,
    localProblem,
    playbackError,
    needsDevice,
    dismissDevicePrompt,
  } = useSpotifyPlayer();
  const [pickerOpen, setPickerOpen] = useState(false);
  const showPicker = pickerOpen || needsDevice;
  const closePicker = useCallback(() => {
    setPickerOpen(false);
    dismissDevicePrompt();
  }, [dismissDevicePrompt]);
  const { locate, toggleLike, likedTrackIds } = useLibrary();

  const [sheetOpen, setSheetOpen] = useState(false);

  const located = locate(currentTrack?.id);

  /**
   * Anything playing that we can't place in a work still gets the same
   * treatment — it just has a single movement.
   */
  const work: LibraryWork | null = useMemo(() => {
    if (located) return located.work;
    if (!currentTrack) return null;
    const albumId = currentTrack.album?.id ?? currentTrack.id;
    const { tint, ink } = tintFor(albumId);
    return {
      id: `track:${currentTrack.id}`,
      workId: null,
      recordingId: null,
      composer: null,
      composerFull: null,
      composerId: null,
      gaps: [],
      ownLink: null,
      albumId: currentTrack.album?.id ?? null,
      composerImage: null,
      era: null,
      years: '',
      title: null,
      nickname: null,
      catalog: null,
      year: null,
      performer: null,
      ensemble: null,
      album: currentTrack.album?.name ?? '',
      cover: currentTrack.album?.images?.[0]?.url ?? null,
      tint,
      ink,
      movements: [
        {
          n: 1,
          position: 1,
          roman: '',
          name: currentTrack.name,
          // Nothing here came from our metadata; it's the raw Spotify track.
          unnamed: true,
          missing: false,
          durationMs: currentTrack.duration_ms,
          duration: formatDuration(currentTrack.duration_ms),
          liked: likedTrackIds.has(currentTrack.id),
          trackId: currentTrack.id,
          uri: currentTrack.uri,
        },
      ],
      unmatched: true,
      addedAt: null,
    };
  }, [located, currentTrack, likedTrackIds]);

  /*
   * The bar spans what this recording actually plays. Movements the recording
   * is missing are shown greyed out in the programme but have no audio, so
   * they take up none of the progress bar.
   */
  const heard = useMemo(() => (work ? playable(work.movements) : []), [work]);
  const movement = located?.movement ?? heard[0] ?? null;

  const durations = useMemo(() => heard.map((m) => m.durationMs ?? 0), [heard]);
  const totalMs = useMemo(() => durations.reduce((a, b) => a + b, 0), [durations]);
  const index = Math.max(
    0,
    heard.findIndex((m) => m.trackId === movement?.trackId),
  );
  const beforeMs = useMemo(
    () => durations.slice(0, index).reduce((a, b) => a + b, 0),
    [durations, index],
  );

  // Drive every progress readout imperatively — the bar's, the phone mini
  // player's and the full-screen sheet's, marked with data-progress — since
  // re-rendering on every frame would be wasteful.
  useEffect(() => {
    if (!work || totalMs === 0) return;
    let frame = 0;
    const tick = () => {
      const progress = getProgress();
      const elapsed = Math.min(totalMs, beforeMs + progress.position);
      const pct = `${(elapsed / totalMs) * 100}%`;
      document.querySelectorAll<HTMLElement>('[data-progress]').forEach((el) => {
        const part = el.dataset.progress;
        if (part === 'fill') el.style.width = pct;
        else if (part === 'head') el.style.left = pct;
        else if (part === 'elapsed') el.textContent = formatDuration(elapsed);
        else if (part === 'remaining') el.textContent = `—${formatDuration(totalMs - elapsed)}`;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [getProgress, work, totalMs, beforeMs]);

  /**
   * Clicking the bar seeks within the work: inside the current movement it is
   * a plain seek, elsewhere it starts that movement at the matching offset.
   */
  const handleScrub = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!work || totalMs === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetMs = ratio * totalMs;

      let acc = 0;
      for (let i = 0; i < heard.length; i++) {
        const next = acc + (heard[i].durationMs ?? 0);
        if (targetMs < next || i === heard.length - 1) {
          const offset = Math.max(0, targetMs - acc);
          if (i === index) {
            seek(offset);
          } else {
            const queue = heard.slice(i).map((m) => m.uri as string);
            play(queue).then(() => seek(offset));
          }
          return;
        }
        acc = next;
      }
    },
    [work, heard, totalMs, index, seek, play],
  );

  const handleVolume = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setVolume(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    },
    [setVolume],
  );

  /** Start the recording from one of its movements. */
  const playFrom = useCallback(
    (i: number) => play(heard.slice(i).map((m) => m.uri as string)),
    [heard, play],
  );

  const tint = work?.tint ?? '#2a1f2e';
  const detailHref = work?.workId ? `/work/${work.workId}?rec=${work.recordingId ?? ''}` : null;

  return (
    <div
      className="relative grid grid-cols-[360px_1fr_320px] items-center border-t border-black/20 px-7 py-[14px] backdrop-blur-[14px] max-[900px]:block max-[900px]:px-3 max-[900px]:py-2"
      style={{
        background: `linear-gradient(180deg, ${hexToRgba(tint, 0.82)}, ${hexToRgba(tint, 0.98)})`,
        color: work?.ink ?? '#f4ecd8',
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/5 to-black/[0.12]" />

      {showPicker && <DevicePicker onClose={closePicker} />}

      {playbackError && (
        <div className="absolute right-0 bottom-full left-0 z-[2] bg-accent px-7 py-[6px] text-center font-display text-[13px] text-paper italic max-[900px]:px-4">
          {playbackError}
        </div>
      )}

      {!work || !movement ? (
        <div className="relative z-[1] col-span-full flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center font-display text-[13px] italic">
          <span className="opacity-75">
            {isReady
              ? outputDevice && !outputDevice.isThisBrowser
                ? `Choose a movement to play on ${outputDevice.name}.`
                : 'Choose a movement to begin.'
              : localStatus === 'unavailable'
                ? localProblem
                : 'Connecting to Spotify…'}
          </span>
          {(isReady || localStatus === 'unavailable') && (
            <button
              type="button"
              data-device-toggle
              onClick={() => (showPicker ? closePicker() : setPickerOpen(true))}
              className="flex cursor-pointer items-center gap-[6px] border-b border-current pb-px font-meta text-[10px] tracking-[0.16em] not-italic uppercase opacity-85 hover:opacity-100"
            >
              <Icon name="devices" size={13} />
              {isReady ? 'Change device' : 'Play on another device'}
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Phones: one compact row that opens the full player. */}
          <div className="relative z-[1] min-[901px]:hidden">
            <div className="absolute -top-2 right-[-12px] left-[-12px] h-[2px] bg-white/15">
              <div data-progress="fill" className="absolute inset-y-0 left-0 bg-current" />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                aria-label="Open the player"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
              >
                <Cover work={work} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-[15px] leading-[1.25]">
                    {movement.roman && (
                      <span className="mr-[6px] italic opacity-70">
                        {numeralPrefix(movement.roman)}
                      </span>
                    )}
                    {movement.name}
                  </span>
                  <span className="block truncate font-display text-[12.5px] italic opacity-75">
                    {outputDevice && !outputDevice.isThisBrowser
                      ? `On ${outputDevice.name}`
                      : [work.composer ?? work.composerFull, work.title]
                          .filter(Boolean)
                          .join(' · ') || 'Work unmatched'}
                  </span>
                </span>
              </button>
              <button
                type="button"
                title={isPaused ? 'Play' : 'Pause'}
                onClick={togglePlay}
                disabled={!isReady}
                className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-current disabled:cursor-default disabled:opacity-35"
              >
                <span className="flex" style={{ color: tint }}>
                  <Icon name={isPaused ? 'play' : 'pause'} size={18} />
                </span>
              </button>
            </div>
          </div>

          {sheetOpen && (
            <NowPlayingSheet
              work={work}
              movement={movement}
              heard={heard}
              durations={durations}
              totalMs={totalMs}
              isPaused={isPaused}
              isReady={isReady}
              detailHref={detailHref}
              outputDevice={outputDevice}
              onClose={() => setSheetOpen(false)}
              onTogglePlay={togglePlay}
              onPrevious={previousTrack}
              onNext={nextTrack}
              onScrub={handleScrub}
              onPlayFrom={playFrom}
              onToggleLike={toggleLike}
              onChooseDevice={() => {
                setSheetOpen(false);
                setPickerOpen(true);
              }}
            />
          )}

          {/* Now playing */}
          <div className="relative z-[1] grid min-w-0 grid-cols-[56px_1fr] items-center gap-[14px] max-[900px]:hidden">
            {detailHref ? (
              <Link href={detailHref} className="block shrink-0">
                <Cover work={work} />
              </Link>
            ) : (
              <Cover work={work} />
            )}
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 font-display text-[15px] leading-[1.2] max-[900px]:text-[14px]">
                {detailHref ? (
                  <Link
                    href={detailHref}
                    className="min-w-0 truncate border-b border-transparent no-underline transition-colors duration-150 hover:border-current"
                  >
                    {movement.roman && (
                      <span className="mr-[6px] italic opacity-70">
                        {numeralPrefix(movement.roman)}
                      </span>
                    )}
                    {movement.name}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate">{movement.name}</span>
                )}
                <button
                  type="button"
                  onClick={() => movement.trackId && toggleLike(movement.trackId)}
                  title={movement.liked ? 'Remove from liked' : 'Like this movement'}
                  className="flex shrink-0 cursor-pointer opacity-55 transition-all duration-150 hover:scale-110 hover:opacity-100"
                >
                  <Icon name={movement.liked ? 'heartFill' : 'heartOutline'} size={12} />
                </button>
              </div>
              <div className="truncate font-display text-[11.5px] italic opacity-75">
                {work.composerFull}
                {!work.composerFull && !work.title && 'Work unmatched'}
                {work.title && (
                  <>
                    {work.composerFull && ' · '}
                    {detailHref ? (
                      <Link
                        href={detailHref}
                        className="border-b border-transparent no-underline transition-colors duration-150 hover:border-current"
                      >
                        <i>{work.title}</i>
                      </Link>
                    ) : (
                      <i>{work.title}</i>
                    )}
                  </>
                )}
                {work.nickname && <> “{work.nickname}”</>}
              </div>
            </div>
          </div>

          {/* Transport + work-scoped progress */}
          <div className="relative z-[1] flex flex-col items-center gap-2 max-[900px]:hidden">
            <div className="flex items-center gap-[18px] max-[900px]:gap-[22px]">
              <button
                type="button"
                title="Shuffle"
                className="cursor-pointer opacity-85 hover:opacity-100"
              >
                <Icon name="shuffle" size={16} />
              </button>
              <button
                type="button"
                title="Previous movement"
                onClick={previousTrack}
                disabled={!isReady}
                className="cursor-pointer opacity-85 hover:opacity-100 disabled:cursor-default disabled:opacity-35"
              >
                <Icon name="prev" size={20} />
              </button>
              <button
                type="button"
                title={isPaused ? 'Play' : 'Pause'}
                onClick={togglePlay}
                disabled={!isReady}
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-current transition-transform duration-150 hover:scale-105 disabled:cursor-default disabled:opacity-35"
              >
                <span className="flex" style={{ color: tint }}>
                  <Icon name={isPaused ? 'play' : 'pause'} size={18} />
                </span>
              </button>
              <button
                type="button"
                title="Next movement"
                onClick={nextTrack}
                disabled={!isReady}
                className="cursor-pointer opacity-85 hover:opacity-100 disabled:cursor-default disabled:opacity-35"
              >
                <Icon name="next" size={20} />
              </button>
              <button
                type="button"
                title="Queue"
                className="cursor-pointer opacity-85 hover:opacity-100"
              >
                <Icon name="queue" size={16} />
              </button>
            </div>

            <div className="flex w-[min(560px,100%)] flex-col gap-1 max-[900px]:w-full">
              <div className="relative flex font-meta text-[9px] tracking-[0.14em] uppercase opacity-65 max-[900px]:hidden">
                {heard.map((m, i) => (
                  <span
                    key={m.n}
                    className={`truncate border-l border-current pr-[6px] pl-[5px] first:border-l-0 first:pl-0 ${
                      m.n === movement.n ? 'font-semibold opacity-100' : ''
                    }`}
                    style={{
                      width: `${(durations[i] / totalMs) * 100}%`,
                      opacity: m.liked ? 1 : 0.45,
                    }}
                  >
                    {m.liked && <span className="mr-1">♥</span>}
                    {numeralPrefix(m.roman)}{' '}
                    {m.name.length > 12 ? `${m.name.slice(0, 12)}…` : m.name}
                  </span>
                ))}
              </div>

              <div
                onClick={handleScrub}
                className="relative h-1 cursor-pointer rounded-[2px] bg-white/15 before:absolute before:-inset-y-3 before:inset-x-0 before:content-['']"
              >
                <div
                  data-progress="fill"
                  className="absolute inset-y-0 left-0 rounded-[2px] bg-current"
                />
                {heard.slice(0, -1).map((m, i) => {
                  const at = durations.slice(0, i + 1).reduce((a, b) => a + b, 0);
                  return (
                    <div
                      key={m.n}
                      className="absolute -top-[2px] -bottom-[2px] w-px bg-white/35"
                      style={{ left: `${(at / totalMs) * 100}%` }}
                    />
                  );
                })}
                <div
                  data-progress="head"
                  className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current shadow-[0_0_0_3px_rgba(0,0,0,0.25)]"
                />
              </div>

              <div className="flex justify-between font-meta text-[10.5px] tabular-nums opacity-70">
                <span data-progress="elapsed">0:00</span>
                <span data-progress="remaining">—{formatDuration(totalMs)}</span>
              </div>
            </div>
          </div>

          {/* Queue + volume */}
          <div className="relative z-[1] flex min-w-0 items-center justify-end gap-[14px] max-[900px]:hidden">
            <button
              type="button"
              title={outputDevice ? `Playing on ${outputDevice.name}` : 'Choose where to play'}
              data-device-toggle
              onClick={() => (showPicker ? closePicker() : setPickerOpen(true))}
              className={`flex min-w-0 cursor-pointer items-center gap-[6px] hover:opacity-100 ${
                outputDevice && !outputDevice.isThisBrowser ? 'opacity-100' : 'opacity-70'
              }`}
            >
              <span className="shrink-0">
                <Icon name="devices" size={16} />
              </span>
              {outputDevice && !outputDevice.isThisBrowser && (
                <span className="max-w-[140px] truncate font-meta text-[10.5px] tracking-[0.04em] max-[900px]:max-w-[90px]">
                  {outputDevice.name}
                </span>
              )}
            </button>
            <button
              type="button"
              title="Queue"
              className="cursor-pointer opacity-70 hover:opacity-100 max-[900px]:hidden"
            >
              <Icon name="queue" size={16} />
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

function Cover({ work }: { work: LibraryWork }) {
  if (!work.cover) {
    return (
      <div
        className="flex h-14 w-14 items-center justify-center rounded-[2px] font-display text-lg max-[900px]:h-11 max-[900px]:w-11"
        style={{ background: hexToRgba(work.ink, 0.14) }}
      >
        {work.composer?.slice(0, 1) ?? ''}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the tinted bar wants the raw asset, not a resized one
    <img
      src={work.cover}
      alt={work.album}
      className="h-14 w-14 rounded-[2px] object-cover shadow-[0_10px_30px_-10px_rgba(0,0,0,0.8)] max-[900px]:h-11 max-[900px]:w-11"
    />
  );
}
