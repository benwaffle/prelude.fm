'use client';

import { useState } from 'react';
import { useAdminFailure } from '../components/AdminFailure';
import {
  recordStreamingUrlSubmission,
  recheckStreamingUrl,
  type ContributionView,
} from '../actions/contribute';
import type { InboxClass } from '../lib/admin-url';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
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
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  const { clearFailure, showFailure } = useAdminFailure();
  const [forms, setForms] = useState<Record<string, { editId: string }>>({});

  async function confirm(releaseMbid: string, albumId: string) {
    clearFailure();
    setPending('Confirming submission…');
    try {
      await recordStreamingUrlSubmission(releaseMbid, albumId, forms[albumId] ?? { editId: '' });
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setPending(null);
    }
  }

  async function recheck(releaseMbid: string) {
    clearFailure();
    setPending('Rechecking MusicBrainz…');
    try {
      await recheckStreamingUrl(releaseMbid);
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setPending(null);
    }
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
        const evidence = (
          <span className="min-w-0">
            <span className="block truncate">{gap.releaseTitle}</span>
            <span className="album-meta">{gap.albumTitle}</span>
            <code className="mono block max-w-[60ch] truncate select-all text-[11px] text-[var(--ink-2)]">
              {gap.spotifyUrl}
            </code>
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
                <button className="act" disabled={busy} onClick={() => recheck(gap.releaseMbid)}>
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
            disabled={busy}
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
                disabled={busy}
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
