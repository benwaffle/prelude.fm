'use client';

import { useEffect, useState } from 'react';
import { mediaDebugEnabled, mediaDiagnostics } from '@/lib/use-media-session';

/**
 * The lock-screen wiring as this phone sees it, shown only after visiting
 * /?media-debug=1, so a notification that stays blank can be checked on the
 * device itself.
 */
export function MediaDebug({ output, spotifyPaused }: { output: string; spotifyPaused: boolean }) {
  // The sheet only renders after a tap, never on the server.
  const [enabled] = useState(mediaDebugEnabled);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [enabled]);

  if (!enabled) return null;
  const d = mediaDiagnostics;
  const rows: [string, string][] = [
    ['Build', (process.env.NEXT_PUBLIC_BUILD ?? 'unknown').slice(0, 7)],
    ['Browser', navigator.userAgent],
    ['Plays on', output],
    ['Spotify', spotifyPaused ? 'paused' : 'playing'],
    ['Silent loop', d.silentLoop],
    ['Track info', d.metadataTitle ?? 'not set'],
    ['Session says', d.playbackState],
    ['Buttons', d.handlers.join(', ') || 'none'],
    ['Frames', String(window.frames.length)],
  ];
  return (
    <div className="mt-8 border-t border-current/15 pt-3 font-meta text-[10.5px] leading-snug opacity-80 select-text">
      <div className="mb-2 tracking-[0.2em] uppercase opacity-70">Lock screen check</div>
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[90px_1fr] gap-2 break-words">
          <span className="opacity-60">{k}</span>
          <span>{v}</span>
        </div>
      ))}
      <div className="mt-2 opacity-60">Recent</div>
      {d.events.map((e, i) => (
        <div key={i}>{e}</div>
      ))}
    </div>
  );
}
