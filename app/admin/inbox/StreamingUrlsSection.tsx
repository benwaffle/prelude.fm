'use client';

import type { ContributionView } from '../actions/inbox-view';
import { recheckSubmission, recordStreamingUrlSubmission } from '../actions/submissions';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';
import {
  EditIdInput,
  GapEvidence,
  LedgerGapRow,
  useRowForms,
  useRowMutation,
} from './LedgerGapRow';

export function StreamingUrlsSection({
  rows,
  total,
  onReload,
  onLoadMore,
}: {
  rows: ContributionView['streamingUrls'];
  total: number;
  onReload: () => Promise<void>;
  onLoadMore: () => void;
}) {
  const { pending, busy, row, mutate } = useRowMutation(onReload);
  const { formOf, setForm } = useRowForms({ editId: '' });

  return (
    <InboxSection
      inboxClass="streaming"
      title="Releases with no Spotify streaming URL"
      channel="TOOL"
      total={total}
      shown={rows.length}
      pending={pending}
      description="Only releases whose URL relations were fetched are listed. Unfetched remains unknown, not missing."
    >
      {rows.map((gap) => {
        const key = `${gap.releaseMbid}:${gap.albumId}`;
        const state = row(key);
        return (
          <LedgerGapRow
            key={key}
            data-inbox-release={gap.releaseMbid}
            data-inbox-album={gap.albumId}
            ledger={gap.ledger}
            busy={state.busy}
            onRecheck={() =>
              mutate(key, 'Rechecking MusicBrainz…', () =>
                recheckSubmission({ kind: 'streaming_url', releaseMbid: gap.releaseMbid }),
              )
            }
            evidence={
              <GapEvidence ledger={gap.ledger} previous={gap.previous} state={state}>
                <span className="block truncate">{gap.releaseTitle}</span>
                <span className="album-meta">{gap.albumTitle}</span>
                <code className="mono block max-w-[60ch] truncate select-all text-[11px] text-[var(--ink-2)]">
                  {gap.spotifyUrl}
                </code>
              </GapEvidence>
            }
            links={
              <a className="act" href={gap.edit} target="_blank" rel="noreferrer">
                MusicBrainz
              </a>
            }
          >
            <div className="toolbar px-0">
              <button className="act" onClick={() => navigator.clipboard.writeText(gap.spotifyUrl)}>
                Copy Spotify URL
              </button>
              <EditIdInput
                value={formOf(key).editId}
                onChange={(editId) => setForm(key, { editId })}
              />
              <button
                className="act"
                data-variant="primary"
                disabled={state.busy}
                onClick={() =>
                  mutate(key, 'Confirming submission…', () =>
                    recordStreamingUrlSubmission(gap.releaseMbid, gap.albumId, formOf(key)),
                  )
                }
              >
                Confirm submission
              </button>
            </div>
          </LedgerGapRow>
        );
      })}
      <LoadMoreRows shown={rows.length} total={total} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
