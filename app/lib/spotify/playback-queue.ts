import type { QueueEntry } from '../prelude';

// Spotify plays the whole handed list itself, so queued recordings follow with no gap even with the
// screen off; the segments tell us which queued recording has started.
export interface Segment {
  entryId: string | null;
  uris: string[];
}

export interface QueueState {
  queue: QueueEntry[];
  segments: Segment[];
  segmentIndex: number;
  dirty: boolean;
}

export const EMPTY_QUEUE: QueueState = { queue: [], segments: [], segmentIndex: 0, dirty: false };

export type QueueAction =
  | { type: 'add'; entry: QueueEntry }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'changed' }
  | { type: 'takeFirst' }
  | { type: 'handedOver'; start: Segment }
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

/** The listener may have skipped past several to get to it. */
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

export function handedUris(state: QueueState): string[] {
  return state.segments.flatMap((s) => s.uris);
}

/** A track we didn't start (from the Spotify app, say) is kept on its own. */
export function restOfCurrent(state: QueueState, track: { uris: string[]; uri: string }): string[] {
  const segment = state.segments[state.segmentIndex];
  const at = segment ? segment.uris.findIndex((u) => track.uris.includes(u)) : -1;
  return at >= 0 ? segment.uris.slice(at) : [track.uri];
}
