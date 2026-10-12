'use client';

import { usePlayer, usePlayerActions } from '@/lib/spotify-player-context';
import { Icon } from '../Icon';

export function QueueList({ onPlayQueue }: { onPlayQueue?: () => void }) {
  const { queue } = usePlayer();
  const { removeFromQueue, clearQueue } = usePlayerActions();

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-meta text-[10px] tracking-[0.2em] uppercase opacity-60">Up next</span>
        {queue.length > 0 && (
          <span className="flex items-baseline gap-4">
            {onPlayQueue && (
              <button
                type="button"
                onClick={onPlayQueue}
                className="cursor-pointer font-meta text-[10px] tracking-[0.16em] uppercase opacity-75 hover:opacity-100"
              >
                Play
              </button>
            )}
            <button
              type="button"
              onClick={clearQueue}
              className="cursor-pointer font-meta text-[10px] tracking-[0.16em] uppercase opacity-75 hover:opacity-100"
            >
              Clear
            </button>
          </span>
        )}
      </div>
      {queue.length === 0 ? (
        <p className="m-0 border-t border-current/15 py-3 font-display text-[14px] leading-snug italic opacity-70">
          Nothing queued. Add a recording from its card or its page to play it after this one.
        </p>
      ) : (
        <ol className="m-0 list-none border-t border-current/15 p-0">
          {queue.map((entry) => (
            <li
              key={entry.id}
              className="flex animate-rise items-center gap-3 border-b border-current/15 py-2"
            >
              {entry.cover ? (
                // eslint-disable-next-line @next/next/no-img-element -- Spotify serves already-sized art
                <img
                  src={entry.cover}
                  alt=""
                  className="h-10 w-10 shrink-0 rounded-[2px] object-cover"
                />
              ) : (
                <span className="h-10 w-10 shrink-0 rounded-[2px] bg-current/10" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-[15px] leading-tight">
                  {entry.title}
                </span>
                {entry.subtitle && (
                  <span className="block truncate font-display text-[12.5px] italic opacity-70">
                    {entry.subtitle}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => removeFromQueue(entry.id)}
                aria-label={`Remove ${entry.title} from the queue`}
                className="-mr-2 flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center opacity-60 hover:opacity-100"
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
