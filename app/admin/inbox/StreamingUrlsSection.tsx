'use client';

import { useState } from 'react';
import { useAdminAction } from '../components/useAdminAction';
import {
  recordStreamingUrlSubmission,
  recheckStreamingUrl,
  type ContributionView,
} from '../actions/contribute';
import type { InboxClass } from '../lib/admin-url';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
import { RowActionStatus } from './RowActionStatus';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';

export function StreamingUrlsSection({
  rows,
  total,
  activeClass,
  onReload,
  onLoadMore,
}: {
  rows: ContributionView['streamingUrls'];
  total: number;
  activeClass?: InboxClass;
  onReload: () => Promise<void>;
  onLoadMore: () => void;
}) {
  const { pending, busy, runRow, row } = useAdminAction();
  const [forms, setForms] = useState<Record<string, { editId: string }>>({});

  async function confirm(releaseMbid: string, albumId: string) {
    await runRow(`${releaseMbid}:${albumId}`, 'Confirming submission…', async () => {
      await recordStreamingUrlSubmission(releaseMbid, albumId, forms[albumId] ?? { editId: '' });
      await onReload();
    });
  }

  async function recheck(releaseMbid: string, albumId: string) {
    await runRow(`${releaseMbid}:${albumId}`, 'Rechecking MusicBrainz…', async () => {
      await recheckStreamingUrl(releaseMbid);
      await onReload();
    });
  }

  return (
    <InboxSection
      inboxClass="streaming"
      activeClass={activeClass}
      title="Releases with no Spotify streaming URL"
      channel="TOOL"
      total={total}
      shown={rows.length}
      pending={pending}
      description="Only releases whose URL relations were fetched are listed. Unfetched remains unknown, not missing."
    >
      {rows.map((gap) => {
        const state = row(`${gap.releaseMbid}:${gap.albumId}`);
        const evidence = (
          <span className="min-w-0">
            <span className="block truncate">{gap.releaseTitle}</span>
            <span className="album-meta">{gap.albumTitle}</span>
            <code className="mono block max-w-[60ch] truncate select-all text-[11px] text-[var(--ink-2)]">
              {gap.spotifyUrl}
            </code>
            <RowActionStatus row={state} />
          </span>
        );
        const links = (
          <a className="act" href={gap.edit} target="_blank" rel="noreferrer">
            MusicBrainz
          </a>
        );

        if (gap.ledger) {
          return (
            <InboxRow
              key={`${gap.releaseMbid}:${gap.albumId}`}
              data-inbox-release={gap.releaseMbid}
              data-inbox-album={gap.albumId}
              evidence={
                <>
                  {evidence}
                  <span className="album-meta">{gap.ledger.label}</span>
                </>
              }
              links={links}
              action={
                <button
                  className="act"
                  disabled={state.busy}
                  onClick={() => recheck(gap.releaseMbid, gap.albumId)}
                >
                  Recheck
                </button>
              }
            />
          );
        }

        const form = forms[gap.albumId] ?? { editId: '' };
        return (
          <ConfirmDisclosure
            key={`${gap.releaseMbid}:${gap.albumId}`}
            data-inbox-release={gap.releaseMbid}
            data-inbox-album={gap.albumId}
            evidence={evidence}
            links={links}
          >
            <div className="toolbar px-0">
              <button className="act" onClick={() => navigator.clipboard.writeText(gap.spotifyUrl)}>
                Copy Spotify URL
              </button>
              <input
                className="mono w-40"
                placeholder="edit ID (optional)"
                value={form.editId}
                onChange={(event) =>
                  setForms((current) => ({
                    ...current,
                    [gap.albumId]: { editId: event.target.value },
                  }))
                }
              />
              <button
                className="act"
                data-variant="primary"
                disabled={state.busy}
                onClick={() => confirm(gap.releaseMbid, gap.albumId)}
              >
                Confirm submission
              </button>
            </div>
          </ConfirmDisclosure>
        );
      })}
      <LoadMoreRows shown={rows.length} total={total} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
