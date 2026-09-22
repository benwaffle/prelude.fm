'use client';

import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { InboxRow } from './InboxRow';

export function ConfirmDisclosure({
  evidence,
  links,
  children,
  label = 'Confirm…',
  disabled = false,
  primary = true,
  initiallyOpen = false,
  ...props
}: {
  evidence: ReactNode;
  links?: ReactNode;
  children: ReactNode;
  label?: string;
  disabled?: boolean;
  primary?: boolean;
  initiallyOpen?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <div className="inbox-row-wrap" {...props}>
      <InboxRow
        evidence={evidence}
        links={links}
        action={
          <button
            className="act shrink-0"
            data-variant={primary ? 'primary' : undefined}
            disabled={disabled}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? 'Close' : label}
          </button>
        }
      />
      {open && <div className="inbox-disclosure">{children}</div>}
    </div>
  );
}
