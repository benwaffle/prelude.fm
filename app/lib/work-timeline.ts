import { formatDuration } from './prelude';

/**
 * Progress through a whole recording rather than one track: the player's
 * bar spans every movement the recording plays, with a seam at each join.
 * Movements the recording lacks have no audio and take up none of it.
 */
export interface WorkTimeline {
  /** Each heard movement's length; an unknown length counts as nothing. */
  durations: number[];
  totalMs: number;
  /** Which heard movement is playing. */
  index: number;
  /** Where the playing movement starts, in milliseconds into the recording. */
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

/** How far into the recording playback is, given the position in the playing movement. */
export function elapsedMs(timeline: WorkTimeline, positionMs: number): number {
  return Math.min(timeline.totalMs, timeline.beforeMs + positionMs);
}

/** Where each join between movements falls, as a fraction of the whole. */
export function seams(timeline: WorkTimeline): number[] {
  const out: number[] = [];
  let at = 0;
  for (const duration of timeline.durations.slice(0, -1)) {
    at += duration;
    out.push(at / timeline.totalMs);
  }
  return out;
}

/** The movement a fraction of the way through falls in, and how far into it. */
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

/**
 * The readouts for a point in the recording, at the precision a reader can
 * see change: the bar by the tenth of a percent, the times by the second.
 * Drawing compares these, so an unchanged frame writes nothing to the page.
 */
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
