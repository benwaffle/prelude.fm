'use client';

import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { useAdminAction, type RowActionState } from '../components/useAdminAction';
import type { LedgerView, SubmissionHistoryView } from '../actions/inbox-view';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
import { PreviousSubmission } from './PreviousSubmission';
import { RowActionStatus } from './RowActionStatus';

/**
 * A section's row actions, plus `mutate`: a row action that writes, then
 * reloads the section so the row shows what it changed.
 */
export function useRowMutation(onReload: () => Promise<void>) {
  const actions = useAdminAction();
  const mutate = (key: string, label: string, change: () => Promise<unknown>) =>
    actions.runRow(key, label, async () => {
      await change();
      await onReload();
    });
  return { ...actions, mutate };
}

/** What each row's confirmation form holds, by row key, until it is sent. */
export function useRowForms<Form extends object>(empty: Form) {
  const [forms, setForms] = useState<Record<string, Form>>({});
  return {
    formOf: (key: string): Form => forms[key] ?? empty,
    setForm: (key: string, patch: Partial<Form>) =>
      setForms((current) => ({ ...current, [key]: { ...(current[key] ?? empty), ...patch } })),
  };
}

/** The optional MusicBrainz edit number beside a confirmation. */
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

/**
 * A gap's evidence, then what happened to an earlier attempt (only while
 * nothing is in hand) and the row's own action status.
 */
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

/**
 * One gap: with a submission in hand, its ledger state and Recheck; without
 * one, a confirmation form behind a disclosure. The gap stays listed either
 * way until the cache shows the edit.
 */
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
  /** What the row in hand says beyond its ledger state. */
  ledgerNote?: ReactNode;
  busy: boolean;
  onRecheck: () => void;
  /** The confirmation form. */
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
    <ConfirmDisclosure {...props} evidence={evidence} links={links}>
      {children}
    </ConfirmDisclosure>
  );
}
