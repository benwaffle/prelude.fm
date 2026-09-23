'use client';

import { useState } from 'react';
import { useAdminFailure } from '../components/AdminFailure';
import {
  recordContestedIsrcReport,
  recheckErrorReport,
  type ContributionView,
} from '../actions/contribute';
import type { InboxClass } from '../lib/admin-url';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';

export function ContestedIsrcsSection({
  rows,
  total,
  activeClass,
  onReload,
  onLoadMore,
}: {
  rows: ContributionView['contested'];
  total: number;
  activeClass?: InboxClass;
  onReload: () => Promise<void>;
  onLoadMore: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  const { clearFailure, showFailure } = useAdminFailure();
  const [forms, setForms] = useState<Record<string, { editId: string }>>({});

  async function confirm(isrc: string, disposition: 'reported' | 'fixed') {
    clearFailure();
    setPending('Confirming submission…');
    try {
      await recordContestedIsrcReport(isrc, disposition, forms[isrc] ?? { editId: '' });
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setPending(null);
    }
  }

  async function recheck(isrc: string) {
    clearFailure();
    setPending('Rechecking MusicBrainz…');
    try {
      await recheckErrorReport('contested_isrc', isrc);
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setPending(null);
    }
  }

  return (
    <InboxSection
      inboxClass="contested"
      activeClass={activeClass}
      title="One ISRC, several recordings"
      channel="REPORT"
      total={total}
      shown={rows.length}
      pending={pending}
      description="An ISRC identifies one recording. Every conflicting MusicBrainz recording remains visible until the cache shows the correction."
    >
      {rows.map((row) => {
        const evidence = (
          <span className="min-w-0">
            <span className="mono block">{row.isrc}</span>
            <span className="block text-[11px] text-[var(--ink-2)]">{row.titles}</span>
            <span className="album-meta">
              {row.recordingMbids.map((mbid) => (
                <span key={mbid} className="mono">
                  {mbid}
                </span>
              ))}
            </span>
          </span>
        );
        const links = (
          <a className="act" href={row.isrcUrl} target="_blank" rel="noreferrer">
            MusicBrainz
          </a>
        );

        if (row.ledger) {
          return (
            <InboxRow
              key={row.isrc}
              evidence={
                <>
                  {evidence}
                  <span className="album-meta">
                    {row.ledger.disposition} · {row.ledger.label}
                  </span>
                </>
              }
              links={links}
              action={
                <button className="act" disabled={busy} onClick={() => recheck(row.isrc)}>
                  Recheck
                </button>
              }
            />
          );
        }

        const form = forms[row.isrc] ?? { editId: '' };
        return (
          <ConfirmDisclosure key={row.isrc} evidence={evidence} links={links} disabled={busy}>
            <div className="toolbar px-0">
              {row.recordingMbids.map((mbid) => (
                <a
                  key={mbid}
                  className="act"
                  href={`https://musicbrainz.org/recording/${mbid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Recording
                </a>
              ))}
              <input
                className="mono w-40"
                placeholder="edit ID (optional)"
                value={form.editId}
                onChange={(event) =>
                  setForms((current) => ({
                    ...current,
                    [row.isrc]: { editId: event.target.value },
                  }))
                }
              />
              <button
                className="act"
                data-variant="primary"
                disabled={busy}
                onClick={() => confirm(row.isrc, 'reported')}
              >
                Confirm report
              </button>
              <button className="act" disabled={busy} onClick={() => confirm(row.isrc, 'fixed')}>
                Confirm fix
              </button>
            </div>
          </ConfirmDisclosure>
        );
      })}
      <LoadMoreRows shown={rows.length} total={total} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
