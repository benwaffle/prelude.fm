'use client';

import { useEffect, useState } from 'react';
import { usePlayerActions } from '@/lib/spotify-player-context';
import { playable, queueEntryFor, type LibraryWork } from '@/lib/prelude';
import { Icon } from '../Icon';

export function AddToQueueButton({
  work,
  className = '',
}: {
  work: LibraryWork;
  className?: string;
}) {
  const { addToQueue } = usePlayerActions();
  const [added, setAdded] = useState(false);

  useEffect(() => {
    if (!added) return;
    const timer = setTimeout(() => setAdded(false), 1600);
    return () => clearTimeout(timer);
  }, [added]);

  return (
    <button
      type="button"
      disabled={playable(work.movements).length === 0}
      onClick={() => {
        addToQueue(queueEntryFor(work));
        setAdded(true);
      }}
      className={`inline-flex cursor-pointer items-center gap-[7px] font-meta text-[10px] tracking-[0.16em] uppercase transition-colors duration-150 disabled:cursor-default disabled:opacity-40 ${className}`}
    >
      <span key={added ? 'added' : 'add'} className="flex animate-pop">
        <Icon name={added ? 'check' : 'queueAdd'} size={13} />
      </span>
      {added ? 'Queued' : 'Add to queue'}
    </button>
  );
}
