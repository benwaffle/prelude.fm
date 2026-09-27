'use client';

import { useState } from 'react';
import { useAdminAction } from '../components/useAdminAction';
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
  const { pending, busy, run } = useAdminAction();
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const openCount = total - (counts.applied ?? 0);
  const pendingCount = counts.pending ?? 0;
  const appliedCount = counts.applied ?? 0;
  const [lastRecheck, setLastRecheck] = useState<string | null>(null);

  async function recheck() {
    setLastRecheck(null);
    await run('Rechecking MusicBrainz…', async () => {
      const result = await reconcileSubmissions();
      setLastRecheck(
        `Fetched ${result.targets} MusicBrainz ${result.targets === 1 ? 'entity' : 'entities'} ` +
          `(${result.requests} ${result.requests === 1 ? 'request' : 'requests'}) covering ` +
          `${result.checked} pending ${result.checked === 1 ? 'submission' : 'submissions'}; ` +
          `${result.applied} now on MusicBrainz, ${result.checked - result.applied} still not.`,
      );
      await onReload();
    });
  }

  return (
    <InboxSection
      inboxClass="submitted"
      activeClass={activeClass}
      title="Submitted"
      channel="REPORT"
      total={openCount}
      shown={rows.length}
      pending={pending}
      countLabel={`${pendingCount} pending · ${appliedCount} already on MusicBrainz, not listed`}
      description="Edits we sent that MusicBrainz does not show yet. An edit may still be open for votes, or it may have failed. Once Recheck finds it on MusicBrainz it leaves this list."
    >
      <div className="toolbar">
        <button className="act" disabled={busy} onClick={recheck}>
          Recheck all
        </button>
        <span className="text-[var(--ink-2)]">
          Recheck fetches each release, recording or work behind a pending row once — many rows
          share one — then marks the rows it now finds. It submits nothing.
        </span>
      </div>
      {lastRecheck && (
        <p role="status" className="px-4 text-[var(--ink-2)]">
          {lastRecheck}
        </p>
      )}
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
