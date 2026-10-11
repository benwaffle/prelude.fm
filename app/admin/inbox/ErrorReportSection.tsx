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

/**
 * A contradiction somebody can report upstream or fix: each row records what
 * the person did (reported or fixed), never a verdict, and stays listed until
 * the cache no longer shows the contradiction.
 */
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
  /** The row's identity, which is also its report's ledger value. */
  keyOf: (row: Row) => string;
  /** `data-inbox-*` attributes that let a link focus the row. */
  rowProps?: (row: Row) => Record<`data-${string}`, string>;
  evidence: (row: Row) => ReactNode;
  links: (row: Row) => ReactNode;
  /** Shown above the confirmation buttons. */
  details?: (row: Row) => ReactNode;
  /** Links beside the confirmation buttons. */
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
