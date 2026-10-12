'use client';

import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { useAdminAction, type RowActionState } from '../components/useAdminAction';
import type { LedgerView, SubmissionHistoryView } from '../actions/inbox-view';
import { RowDisclosure } from './RowDisclosure';
import { InboxRow } from './InboxRow';
import { PreviousSubmission } from './PreviousSubmission';
import { RowActionStatus } from './RowActionStatus';

export function useRowMutation(onReload: () => Promise<void>) {
  const actions = useAdminAction();
  const mutate = (key: string, label: string, change: () => Promise<unknown>) =>
    actions.runRow(key, label, async () => {
      await change();
      await onReload();
    });
  return { ...actions, mutate };
}

export function useRowForms<Form extends object>(empty: Form) {
  const [forms, setForms] = useState<Record<string, Form>>({});
  return {
    formOf: (key: string): Form => forms[key] ?? empty,
    setForm: (key: string, patch: Partial<Form>) =>
      setForms((current) => ({ ...current, [key]: { ...(current[key] ?? empty), ...patch } })),
  };
}

export function EditIdInput({
  value,
  onChange,
  className = 'w-40',
}: {
  value: string;
  onChange: (editId: string) => void;
  className?: string;
}) {
  return (
    <input
      className={`mono ${className}`}
      placeholder="edit ID (optional)"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function GapEvidence({
  children,
  ledger,
  previous,
  state,
}: {
  children: ReactNode;
  ledger: LedgerView | null;
  previous: SubmissionHistoryView | null;
  state: RowActionState;
}) {
  return (
    <span className="min-w-0">
      {children}
      {!ledger && previous && <PreviousSubmission previous={previous} />}
      <RowActionStatus row={state} />
    </span>
  );
}

/** The gap stays listed until the cache shows the edit. */
export function LedgerGapRow({
  ledger,
  evidence,
  links,
  ledgerNote,
  busy,
  onRecheck,
  children,
  ...props
}: {
  ledger: LedgerView | null;
  evidence: ReactNode;
  links: ReactNode;
  ledgerNote?: ReactNode;
  busy: boolean;
  onRecheck: () => void;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  if (ledger) {
    return (
      <InboxRow
        {...props}
        evidence={
          <>
            {evidence}
            {ledgerNote ?? <span className="album-meta">{ledger.label}</span>}
          </>
        }
        links={links}
        action={
          <button className="act" disabled={busy} onClick={onRecheck}>
            Recheck
          </button>
        }
      />
    );
  }
  return (
    <RowDisclosure {...props} evidence={evidence} links={links}>
      {children}
    </RowDisclosure>
  );
}
