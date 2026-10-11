import type { ReactNode } from 'react';
import { shownOfTotalLabel } from '@/lib/contribution-list';
import type { InboxClass } from '../lib/admin-url';
import { ChannelBadge, type ContributionChannel } from './ChannelBadge';

export function InboxSection({
  inboxClass,
  title,
  channel,
  total,
  shown,
  countLabel,
  pending,
  description,
  children,
  emptyLabel = '0 to fix',
}: {
  inboxClass: InboxClass;
  title: string;
  channel: ContributionChannel;
  total: number;
  shown: number;
  countLabel?: ReactNode;
  pending?: string | null;
  description?: ReactNode;
  children?: ReactNode;
  emptyLabel?: string;
}) {
  return (
    <section id={`inbox-${inboxClass}`} className="panel scroll-mt-28">
      <div className="panel-head">
        <ChannelBadge channel={channel} />
        <h2 className="panel-title">{title}</h2>
        <span className="mono text-[var(--ink-2)]">
          {countLabel ?? (total === 0 ? emptyLabel : `${total} to fix`)}
        </span>
        {total > 0 && shown < total && (
          <span className="text-[11px] text-[var(--faint)]">{shownOfTotalLabel(shown, total)}</span>
        )}
      </div>
      {pending && (
        <div
          role="status"
          aria-live="polite"
          className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--rule)] bg-[var(--slip)] px-4 py-2 text-[var(--ink-2)]"
        >
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent"
          />
          {pending}
        </div>
      )}
      {total > 0 && description && (
        <div className="inbox-section-note text-[var(--ink-2)]">{description}</div>
      )}
      {total > 0 && children}
    </section>
  );
}
