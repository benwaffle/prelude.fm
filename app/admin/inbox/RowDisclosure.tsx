'use client';

import { useState, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { InboxRow } from './InboxRow';

/** Clicking the row opens it; links and buttons inside it keep their own clicks. */
export function RowDisclosure({
  evidence,
  links,
  extraAction,
  children,
  ...props
}: {
  evidence: ReactNode;
  links?: ReactNode;
  /** Shown beside the toggle, so it stays reachable while the row is closed. */
  extraAction?: ReactNode;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  const [open, setOpen] = useState(false);

  function onRowClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, select, textarea, label')) return;
    if (window.getSelection()?.toString()) return;
    setOpen((current) => !current);
  }

  return (
    <div className="inbox-row-wrap" {...props}>
      <InboxRow
        className="inbox-row-toggle"
        onClick={onRowClick}
        evidence={evidence}
        links={links}
        action={
          <>
            {extraAction}
            <button
              className="inbox-chevron"
              aria-expanded={open}
              aria-label={open ? 'Hide details' : 'Show details'}
              onClick={() => setOpen((current) => !current)}
            >
              ▸
            </button>
          </>
        }
      />
      {open && <div className="inbox-disclosure">{children}</div>}
    </div>
  );
}
