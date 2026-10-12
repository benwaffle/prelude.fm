'use client';

import type { ReactNode } from 'react';
import type { ErrorLedgerView, SubmissionHistoryView } from '../actions/inbox-view';
import { recheckSubmission } from '../actions/submissions';
import type { InboxClass } from '../lib/admin-url';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';
import {
  EditIdInput,
  GapEvidence,
  LedgerGapRow,
  useRowForms,
  useRowMutation,
} from './LedgerGapRow';

type ErrorReportRow = { ledger: ErrorLedgerView | null; previous: SubmissionHistoryView | null };

// Records what the person did, never a verdict; stays listed until the cache no longer shows the
// contradiction.
export function ErrorReportSection<Row extends ErrorReportRow>({
  inboxClass,
  title,
  description,
  rows,
  total,
  onReload,
  onLoadMore,
  keyOf,
  rowProps,
  evidence,
  links,
  details,
  tools,
  record,
}: {
  inboxClass: InboxClass;
  title: string;
  description: string;
  rows: Row[];
  total: number;
  onReload: () => Promise<void>;
  onLoadMore: () => void;
  keyOf: (row: Row) => string;
  rowProps?: (row: Row) => Record<`data-${string}`, string>;
  evidence: (row: Row) => ReactNode;
  links: (row: Row) => ReactNode;
  details?: (row: Row) => ReactNode;
  tools: (row: Row) => ReactNode;
  record: (
    key: string,
    disposition: 'reported' | 'fixed',
    options: { editId: string },
  ) => Promise<void>;
}) {
  const { pending, busy, row: rowState, mutate } = useRowMutation(onReload);
  const { formOf, setForm } = useRowForms({ editId: '' });

  function confirm(key: string, disposition: 'reported' | 'fixed') {
    return mutate(key, 'Confirming submission…', () => record(key, disposition, formOf(key)));
  }

  return (
    <InboxSection
      inboxClass={inboxClass}
      title={title}
      channel="REPORT"
      total={total}
      shown={rows.length}
      pending={pending}
      description={description}
    >
      {rows.map((row) => {
        const key = keyOf(row);
        const state = rowState(key);
        return (
          <LedgerGapRow
            key={key}
            {...rowProps?.(row)}
            ledger={row.ledger}
            busy={state.busy}
            onRecheck={() =>
              mutate(key, 'Rechecking MusicBrainz…', () =>
                recheckSubmission({ kind: 'error', value: key }),
              )
            }
            evidence={
              <GapEvidence ledger={row.ledger} previous={row.previous} state={state}>
                {evidence(row)}
              </GapEvidence>
            }
            links={links(row)}
            ledgerNote={
              row.ledger && (
                <span className="album-meta">
                  {row.ledger.disposition} · {row.ledger.label}
                </span>
              )
            }
          >
            {details?.(row)}
            <div className="toolbar px-0">
              {tools(row)}
              <EditIdInput
                value={formOf(key).editId}
                onChange={(editId) => setForm(key, { editId })}
              />
              <button
                className="act"
                data-variant="primary"
                disabled={state.busy}
                onClick={() => confirm(key, 'reported')}
              >
                Confirm report
              </button>
              <button className="act" disabled={state.busy} onClick={() => confirm(key, 'fixed')}>
                Confirm fix
              </button>
            </div>
          </LedgerGapRow>
        );
      })}
      <LoadMoreRows shown={rows.length} total={total} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
