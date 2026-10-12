'use client';

import { useDismiss } from '../DevicePicker';
import { QueueList } from './QueueList';

export function QueuePanel({ onClose }: { onClose: () => void }) {
  const panelRef = useDismiss('[data-queue-toggle]', onClose);

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
