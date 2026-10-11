'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { usePlayer, usePlayerActions } from '@/lib/spotify-player-context';
import { formatDuration } from '@/lib/prelude';
import { elapsedMs, readout, seams } from '@/lib/work-timeline';
import type { Programme } from './use-programme';

interface Readouts {
  fill: RefObject<HTMLDivElement | null>;
  head?: RefObject<HTMLDivElement | null>;
  elapsed?: RefObject<HTMLSpanElement | null>;
  remaining?: RefObject<HTMLSpanElement | null>;
}

/**
 * Draw progress straight into the readouts, not through React state:
 * re-rendering on every frame would be wasteful, and the library behind the
 * bar runs to tens of thousands of elements. Only what a reader could see
 * change is written. It redraws every frame while playing, and while paused
 * only when Spotify reports a new position (a seek, say) or a drag moves.
 *
 * Returns a redraw, for a drag while paused.
 */
function useProgressDrawing(
  programme: Programme,
  dragRatio: RefObject<number | null>,
  readouts: Readouts,
): RefObject<() => void> {
  const { isPaused } = usePlayer();
  const { getProgress, subscribeToProgress } = usePlayerActions();
  const draw = useRef<() => void>(() => {});
  const { timeline } = programme;

  useEffect(() => {
    const { totalMs } = timeline;
    if (totalMs === 0) return;
    let last = { pct: '', elapsed: '', remaining: '' };
    draw.current = () => {
      const dragged = dragRatio.current;
      const ms = dragged !== null ? dragged * totalMs : elapsedMs(timeline, getProgress().position);
      const next = readout(ms, totalMs);
      const { fill, head, elapsed, remaining } = readouts;
      if (next.pct !== last.pct) {
        if (fill.current) fill.current.style.width = next.pct;
        if (head?.current) head.current.style.left = next.pct;
      }
      if (elapsed?.current && next.elapsed !== last.elapsed) {
        elapsed.current.textContent = next.elapsed;
      }
      if (remaining?.current && next.remaining !== last.remaining) {
        remaining.current.textContent = next.remaining;
      }
      last = next;
    };
    draw.current();
    if (isPaused) return subscribeToProgress(() => draw.current());
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      draw.current();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // The readout refs are stable; the drawing restarts with the timeline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, isPaused, getProgress, subscribeToProgress]);

  return draw;
}

const NO_DRAG = { current: null };

/** The phone bar's hairline of progress along its top edge. */
export function ProgressLine({ programme }: { programme: Programme }) {
  const fill = useRef<HTMLDivElement>(null);
  useProgressDrawing(programme, NO_DRAG, { fill });
  return (
    <div className="absolute -top-2 right-[-12px] left-[-12px] h-[2px] bg-white/15">
      <div ref={fill} className="absolute inset-y-0 left-0 bg-current" />
    </div>
  );
}

/**
 * Progress through the whole recording: a seam at each movement, the times,
 * and tap or drag to seek (the seek happens on release).
 */
export function WorkProgress({ programme, size }: { programme: Programme; size: 'bar' | 'sheet' }) {
  const fill = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const elapsed = useRef<HTMLSpanElement>(null);
  const remaining = useRef<HTMLSpanElement>(null);
  // While a finger or mouse drags along the bar, the readouts follow it.
  const dragRatio = useRef<number | null>(null);
  const draw = useProgressDrawing(programme, dragRatio, { fill, head, elapsed, remaining });
  const { timeline, seekToRatio } = programme;

  const ratioAt = (e: React.PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  };
  const dragTo = (ratio: number | null) => {
    dragRatio.current = ratio;
    draw.current();
  };

  const sheet = size === 'sheet';
  return (
    <>
      <div
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragTo(ratioAt(e));
        }}
        onPointerMove={(e) => {
          if (dragRatio.current !== null) dragTo(ratioAt(e));
        }}
        onPointerUp={(e) => {
          if (dragRatio.current === null) return;
          const ratio = ratioAt(e);
          seekToRatio(ratio);
          // Hold the playhead where it was dropped until Spotify catches up.
          setTimeout(() => {
            if (dragRatio.current === ratio) dragTo(null);
          }, 800);
        }}
        onPointerCancel={() => dragTo(null)}
        className={
          sheet
            ? "relative h-[5px] cursor-pointer touch-none rounded-[3px] bg-white/20 before:absolute before:-inset-y-4 before:inset-x-0 before:content-['']"
            : "relative h-1 cursor-pointer touch-none rounded-[2px] bg-white/15 before:absolute before:-inset-y-3 before:inset-x-0 before:content-['']"
        }
      >
        <div
          ref={fill}
          className={`absolute inset-y-0 left-0 bg-current ${sheet ? 'rounded-[3px]' : 'rounded-[2px]'}`}
        />
        {seams(timeline).map((at, i) => (
          <div
            key={i}
            className={`absolute w-px ${sheet ? '-top-[3px] -bottom-[3px] bg-white/40' : '-top-[2px] -bottom-[2px] bg-white/35'}`}
            style={{ left: `${at * 100}%` }}
          />
        ))}
        <div
          ref={head}
          className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ${
            sheet ? 'h-[13px] w-[13px]' : 'h-[9px] w-[9px] shadow-[0_0_0_3px_rgba(0,0,0,0.25)]'
          }`}
        />
      </div>
      <div
        className={`flex justify-between font-meta tabular-nums opacity-70 ${sheet ? 'mt-2 text-[11px]' : 'text-[10.5px]'}`}
      >
        <span ref={elapsed}>0:00</span>
        <span ref={remaining}>—{formatDuration(timeline.totalMs)}</span>
      </div>
    </>
  );
}
