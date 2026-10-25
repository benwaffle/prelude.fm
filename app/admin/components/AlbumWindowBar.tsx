'use client';

import { useState } from 'react';
import type { AlbumWindowView } from '@/lib/gaps/album-window';

// Where the window starts, and the starts of the windows before it, for Previous. `moved` is false
// until the reader pages, so a page can open on a linked album's window instead.
export function useAlbumWindow() {
  const [from, setFrom] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<(string | null)[]>([]);
  const [moved, setMoved] = useState(false);
  return {
    from,
    moved,
    canGoBack: earlier.length > 0,
    first: () => {
      setFrom(null);
      setEarlier([]);
      setMoved(true);
    },
    back: () => {
      setFrom(earlier.at(-1) ?? null);
      setEarlier((stack) => stack.slice(0, -1));
      setMoved(true);
    },
    next: (start: string) => {
      setEarlier((stack) => [...stack, from]);
      setFrom(start);
      setMoved(true);
    },
  };
}

// Says which albums a list covers: the library is read a window at a time, so a count or an order
// is for these albums only, not the library.
export function AlbumWindowBar({
  window,
  nav,
  what,
}: {
  window: AlbumWindowView;
  nav: ReturnType<typeof useAlbumWindow>;
  /** What the window limits, e.g. "These counts". */
  what: string;
}) {
  const span =
    window.albums === 0
      ? 'No albums from here on'
      : `${window.albums.toLocaleString()} albums in Spotify ID order, ${
          window.from ? `from ${window.from}` : 'from the first'
        }${window.next ? '' : ' to the last'}`;
  return (
    <div className="toolbar text-[11px] text-[var(--ink-2)]">
      <span className="flex-1">
        {span}. {what} cover these albums only: page through for the rest.
      </span>
      <button className="act" onClick={nav.first}>
        First
      </button>
      <button className="act" onClick={nav.back} disabled={!nav.canGoBack}>
        Previous
      </button>
      <button
        className="act"
        onClick={() => window.next && nav.next(window.next)}
        disabled={!window.next}
      >
        Next {window.size}
      </button>
    </div>
  );
}
