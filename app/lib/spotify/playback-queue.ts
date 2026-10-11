import type { QueueEntry } from '../prelude';

/**
 * What Spotify was last given to play, in the pieces it came from: what the
 * listener started, then each queued recording. Spotify plays the list through
 * on its own, so queued recordings follow on with no gap even with the screen
 * off; the pieces let us tell which queued recording has started.
 */
export interface Segment {
  entryId: string | null;
  uris: string[];
}

export interface QueueState {
  /** Recordings waiting to play after what's playing now. */
  queue: QueueEntry[];
  /** What Spotify holds, in pieces. */
  segments: Segment[];
  /** Which segment is playing; segments before it are done. */
  segmentIndex: number;
  /** The queue changed and Spotify hasn't been told yet. */
  dirty: boolean;
}

export const EMPTY_QUEUE: QueueState = { queue: [], segments: [], segmentIndex: 0, dirty: false };

export type QueueAction =
  | { type: 'add'; entry: QueueEntry }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  /** Something is loaded and the queue moved under it: Spotify needs telling. */
  | { type: 'changed' }
  /** The first queued recording is about to be played; it leaves the queue. */
  | { type: 'takeFirst' }
  /** Spotify was handed `start` with the whole queue after it. */
  | { type: 'handedOver'; start: Segment }
  /** Spotify reports this track (by every URI it goes by) playing. */
  | { type: 'trackStarted'; uris: string[] };

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case 'add':
      return { ...state, queue: [...state.queue, action.entry] };
    case 'remove':
      return { ...state, queue: state.queue.filter((e) => e.id !== action.id) };
    case 'clear':
      return state.queue.length === 0 ? state : { ...state, queue: [] };
    case 'changed':
      return state.dirty ? state : { ...state, dirty: true };
    case 'takeFirst':
      return state.queue.length === 0 ? state : { ...state, queue: state.queue.slice(1) };
    case 'handedOver':
      return {
        ...state,
        segments: [action.start, ...state.queue.map((e) => ({ entryId: e.id, uris: e.uris }))],
        segmentIndex: 0,
        dirty: false,
      };
    case 'trackStarted':
      return trackStarted(state, action.uris);
  }
}

/**
 * When a queued recording starts, it leaves the queue (and so do any the
 * listener skipped past to get to it).
 */
function trackStarted(state: QueueState, uris: string[]): QueueState {
  if (uris.length === 0) return state;
  const { segments } = state;
  for (let i = state.segmentIndex; i < segments.length; i++) {
    if (!segments[i].uris.some((u) => uris.includes(u))) continue;
    const startedId = segments[i].entryId;
    const at = startedId === null ? -1 : state.queue.findIndex((e) => e.id === startedId);
    if (i === state.segmentIndex && at < 0) return state;
    return {
      ...state,
      segmentIndex: i,
      queue: at >= 0 ? state.queue.slice(at + 1) : state.queue,
    };
  }
  return state;
}

/** Every URI Spotify was handed, in order. */
export function handedUris(state: QueueState): string[] {
  return state.segments.flatMap((s) => s.uris);
}

/**
 * The rest of what's playing now, from the playing track on, so it can be
 * handed to Spotify again with a changed queue after it. A track we didn't
 * start (from the Spotify app, say) is kept on its own.
 */
export function restOfCurrent(state: QueueState, track: { uris: string[]; uri: string }): string[] {
  const segment = state.segments[state.segmentIndex];
  const at = segment ? segment.uris.findIndex((u) => track.uris.includes(u)) : -1;
  return at >= 0 ? segment.uris.slice(at) : [track.uri];
}
