import type { ReactNode } from 'react';
import { shownOfTotalLabel } from '@/lib/contribution-list';
import type { InboxClass } from '../lib/admin-url';
import { ChannelBadge, type ContributionChannel } from './ChannelBadge';

export function InboxStage({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="inbox-stage">
      <p className="eyebrow inbox-stage-label">{label}</p>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}

export function InboxSection({
  inboxClass,
  activeClass,
  title,
  channel,
  total,
  shown,
  countLabel,
  description,
  children,
  emptyLabel = '0 to fix',
}: {
  inboxClass: InboxClass;
  activeClass?: InboxClass;
  title: string;
  channel: ContributionChannel;
  total: number;
  shown: number;
  countLabel?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  emptyLabel?: string;
}) {
  return (
    <section
      id={`inbox-${inboxClass}`}
      className="panel scroll-mt-28"
      data-inbox-highlight={activeClass === inboxClass ? 'true' : undefined}
    >
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
      {total > 0 && description && (
        <div className="inbox-section-note text-[var(--ink-2)]">{description}</div>
      )}
      {total > 0 && children}
    </section>
  );
}
