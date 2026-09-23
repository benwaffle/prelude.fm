'use client';

import { useState } from 'react';
import { useAdminFailure } from '../components/AdminFailure';
import { reconcileSubmissions, type ContributionView } from '../actions/contribute';
import type { InboxClass } from '../lib/admin-url';
import { InboxRow } from './InboxRow';
import { InboxSection } from './InboxSection';

export function SubmittedSection({
  rows,
  counts,
  activeClass,
  onReload,
}: {
  rows: ContributionView['recent'];
  counts: ContributionView['counts']['submissions'];
  activeClass?: InboxClass;
  onReload: () => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  const { clearFailure, showFailure } = useAdminFailure();
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const pendingCount = counts.pending ?? 0;

  async function recheck() {
    clearFailure();
    setPending('Rechecking MusicBrainz…');
    try {
      await reconcileSubmissions();
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setPending(null);
    }
  }

  return (
    <InboxSection
      inboxClass="submitted"
      activeClass={activeClass}
      title="Submitted"
      channel="REPORT"
      total={total}
      shown={rows.length}
      pending={pending}
      countLabel={`${total} ledgered · ${pendingCount} pending`}
      description="A submitted edit remains a proposal until Recheck fetches it into the cache."
    >
      <div className="toolbar">
        <button className="act" disabled={busy} onClick={recheck}>
          Recheck all
        </button>
        <span className="text-[var(--ink-2)]">
          Recheck fetches MusicBrainz into the cache, then updates ledger status; it submits
          nothing.
        </span>
      </div>
      {rows.map((row) => (
        <InboxRow
          key={row.id}
          evidence={
            <>
              <span className="tag">{row.kind}</span>
              <span className="mono">{row.value}</span>
              <span className="text-[var(--ink-2)]">
                {row.submittedBy} · {new Date(row.submittedAt).toLocaleDateString()}
              </span>
            </>
          }
          action={<span className="tag">{row.outcome}</span>}
        />
      ))}
    </InboxSection>
  );
}
