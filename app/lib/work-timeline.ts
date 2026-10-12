import { formatDuration } from './prelude';

/** Movements the recording lacks have no audio and take up none of the bar. */
export interface WorkTimeline {
  /** An unknown length counts as nothing. */
  durations: number[];
  totalMs: number;
  index: number;
  beforeMs: number;
}

export function workTimeline(
  heard: { durationMs: number | null; trackId: string | null }[],
  playingTrackId: string | null,
): WorkTimeline {
  const durations = heard.map((m) => m.durationMs ?? 0);
  const index = Math.max(
    0,
    heard.findIndex((m) => m.trackId === playingTrackId),
  );
  return {
    durations,
    totalMs: sum(durations),
    index,
    beforeMs: sum(durations.slice(0, index)),
  };
}

export function elapsedMs(timeline: WorkTimeline, positionMs: number): number {
  return Math.min(timeline.totalMs, timeline.beforeMs + positionMs);
}

export function seams(timeline: WorkTimeline): number[] {
  const out: number[] = [];
  let at = 0;
  for (const duration of timeline.durations.slice(0, -1)) {
    at += duration;
    out.push(at / timeline.totalMs);
  }
  return out;
}

export function locate(
  timeline: WorkTimeline,
  ratio: number,
): { index: number; offsetMs: number } | null {
  const { durations, totalMs } = timeline;
  if (totalMs === 0 || durations.length === 0) return null;
  const targetMs = ratio * totalMs;
  let acc = 0;
  for (let i = 0; i < durations.length; i++) {
    const next = acc + durations[i];
    if (targetMs < next || i === durations.length - 1) {
      return { index: i, offsetMs: Math.max(0, targetMs - acc) };
    }
    acc = next;
  }
  return null;
}

/** At the precision a reader can see change, so an unchanged frame writes nothing to the page. */
export function readout(
  ms: number,
  totalMs: number,
): { pct: string; elapsed: string; remaining: string } {
  return {
    pct: `${((ms / totalMs) * 100).toFixed(1)}%`,
    elapsed: formatDuration(ms),
    remaining: `—${formatDuration(totalMs - ms)}`,
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
