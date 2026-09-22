import type { HTMLAttributes, ReactNode } from 'react';

export function InboxRow({
  evidence,
  links,
  action,
  className = '',
  ...props
}: {
  evidence: ReactNode;
  links?: ReactNode;
  action?: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`inbox-row ${className}`} {...props}>
      <div className="inbox-evidence">{evidence}</div>
      <div className="inbox-links">{links}</div>
      <div className="inbox-action">{action}</div>
    </div>
  );
}
