'use client';

import { useEffect, useRef } from 'react';
import { QueueList } from './QueueList';

/** The queue, opened from the desktop player bar. */
export function QueuePanel({ onClose }: { onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);

  // As with the device picker, the bar's blur traps an overlay, so outside
  // taps are caught on the document.
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element;
      if (target.closest?.('[data-queue-toggle]')) return;
      if (panelRef.current && !panelRef.current.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const timer = setTimeout(() => document.addEventListener('pointerdown', onPointer));
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Queue"
      className="absolute right-4 bottom-full z-[20] mb-2 max-h-[min(480px,70vh)] w-[360px] animate-rise overflow-y-auto rounded-[3px] border border-rule bg-paper px-4 pt-3 pb-2 text-ink shadow-deep"
    >
      <QueueList />
    </div>
  );
}
