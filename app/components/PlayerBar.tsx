'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef } from 'react';
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
  } = useSpotifyPlayer();
  const { locate, toggleLike, likedTrackIds } = useLibrary();

  const fillRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const remainingRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

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
      composer: currentTrack.artists?.[0]?.name ?? '',
      composerFull: currentTrack.artists?.[0]?.name ?? '',
      composerId: null,
      composerImage: null,
      era: null,
      years: '',
      title: currentTrack.album?.name ?? currentTrack.name,
      nickname: null,
      catalog: null,
      year: null,
      performer: currentTrack.artists?.map((a) => a.name).join(', ') ?? '',
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

  // Drive the bar imperatively; re-rendering on every frame would be wasteful.
  useEffect(() => {
    if (!work || totalMs === 0) return;
    let frame = 0;
    const tick = () => {
      const progress = getProgress();
      const elapsed = Math.min(totalMs, beforeMs + progress.position);
      const pct = (elapsed / totalMs) * 100;
      if (fillRef.current) fillRef.current.style.width = `${pct}%`;
      if (headRef.current) headRef.current.style.left = `${pct}%`;
      if (elapsedRef.current) elapsedRef.current.textContent = formatDuration(elapsed);
      if (remainingRef.current)
        remainingRef.current.textContent = `—${formatDuration(totalMs - elapsed)}`;
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
    (e: React.MouseEvent<HTMLDivElement>) => {
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

  const tint = work?.tint ?? '#2a1f2e';
  const detailHref = work?.workId ? `/work/${work.workId}?rec=${work.recordingId ?? ''}` : null;

  return (
    <div
      className="fixed right-0 bottom-0 left-0 z-10 grid grid-cols-[360px_1fr_320px] items-center border-t border-black/20 px-7 py-[14px] backdrop-blur-[14px] max-[900px]:grid-cols-[minmax(0,1fr)_auto] max-[900px]:gap-x-3 max-[900px]:gap-y-[10px] max-[900px]:px-[14px] max-[900px]:pt-[10px] max-[900px]:pb-3"
      style={{
        background: `linear-gradient(180deg, ${hexToRgba(tint, 0.82)}, ${hexToRgba(tint, 0.98)})`,
        color: work?.ink ?? '#f4ecd8',
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/5 to-black/[0.12]" />

      {!work || !movement ? (
        <div className="relative z-[1] col-span-full text-center font-display text-[13px] italic opacity-75">
          {isReady ? 'Choose a movement to begin.' : 'Connecting to Spotify…'}
        </div>
      ) : (
        <>
          {/* Now playing */}
          <div className="relative z-[1] grid min-w-0 grid-cols-[56px_1fr] items-center gap-[14px] max-[900px]:col-start-1 max-[900px]:row-start-1 max-[900px]:grid-cols-[44px_1fr]">
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
                {work.title && (
                  <>
                    {' · '}
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
          <div className="relative z-[1] flex flex-col items-center gap-2 max-[900px]:col-span-full max-[900px]:row-start-2 max-[900px]:gap-[6px]">
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
                ref={barRef}
                onClick={handleScrub}
                className="relative h-1 cursor-pointer rounded-[2px] bg-white/15"
              >
                <div ref={fillRef} className="absolute inset-y-0 left-0 rounded-[2px] bg-current" />
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
                  ref={headRef}
                  className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current shadow-[0_0_0_3px_rgba(0,0,0,0.25)]"
                />
              </div>

              <div className="flex justify-between font-meta text-[10.5px] tabular-nums opacity-70">
                <span ref={elapsedRef}>0:00</span>
                <span ref={remainingRef}>—{formatDuration(totalMs)}</span>
              </div>
            </div>
          </div>

          {/* Queue + volume */}
          <div className="relative z-[1] flex items-center justify-end gap-[14px] max-[900px]:col-start-2 max-[900px]:row-start-1">
            <button
              type="button"
              title="Queue"
              className="cursor-pointer opacity-70 hover:opacity-100"
            >
              <Icon name="queue" size={16} />
            </button>
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
        {work.composer.slice(0, 1)}
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
