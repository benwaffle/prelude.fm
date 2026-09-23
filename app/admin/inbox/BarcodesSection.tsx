'use client';

import { useState } from 'react';
import { useAdminFailure } from '../components/AdminFailure';
import {
  getBarcodeBotPayload,
  recordBarcodeSubmission,
  recheckBarcode,
  submitBarcodeBotBatch,
  type BotStatus,
  type ContributionView,
} from '../actions/contribute';
import type { InboxClass } from '../lib/admin-url';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';
import { BotSubmissionNotice } from './BotSubmissionNotice';
import { useBotSubmission } from './useBotSubmission';

export function BarcodesSection({
  rows,
  total,
  bot,
  activeClass,
  onReload,
  onBotChange,
  onLoadMore,
}: {
  rows: ContributionView['barcodes'];
  total: number;
  bot: BotStatus | null;
  activeClass?: InboxClass;
  onReload: () => Promise<void>;
  onBotChange: (bot: BotStatus) => void;
  onLoadMore: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  const { clearFailure, showFailure } = useAdminFailure();
  const [forms, setForms] = useState<Record<string, { editId: string }>>({});
  const [payload, setPayload] = useState<{ releaseMbid: string; xml: string } | null>(null);
  const { feedback: submissionFeedback, submit } = useBotSubmission({
    clearFailure,
    showFailure,
    setPending,
    onBotChange,
    onReload,
  });

  async function confirmHand(releaseMbid: string) {
    clearFailure();
    setPending('Confirming hand submission…');
    try {
      await recordBarcodeSubmission(releaseMbid, forms[releaseMbid] ?? { editId: '' });
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setPending(null);
    }
  }

  async function submitBot(releaseMbid: string, releaseTitle: string) {
    await submit(
      releaseMbid,
      submitBarcodeBotBatch,
      () => `${releaseTitle}: submitted barcode. It stays pending until MusicBrainz shows it.`,
      'No eligible barcode was found for this release.',
    );
  }

  async function revealPayload(releaseMbid: string) {
    if (payload?.releaseMbid === releaseMbid) {
      setPayload(null);
      return;
    }
    clearFailure();
    setPending('Loading bot payload…');
    try {
      setPayload({ releaseMbid, xml: await getBarcodeBotPayload(releaseMbid) });
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
      await recheckBarcode(releaseMbid);
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setPending(null);
    }
  }

  return (
    <InboxSection
      inboxClass="barcodes"
      activeClass={activeClass}
      title="Releases with no barcode"
      channel="BOT"
      total={total}
      shown={rows.length}
      pending={pending}
      description="These releases were matched by title and duration. The Spotify barcode is shown as evidence and stays pending until the cache holds it."
    >
      {rows.map((gap) => {
        const evidence = (
          <span className="min-w-0">
            <span className="block truncate">{gap.releaseTitle}</span>
            <span className="album-meta">
              title matched · {gap.trackCount} tracks · worst duration difference{' '}
              {gap.maxDurationDeltaMs}ms
            </span>
            <code className="mono block select-all text-[11px] text-[var(--ink-2)]">
              {gap.barcode}
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
              key={gap.releaseMbid}
              data-inbox-release={gap.releaseMbid}
              evidence={
                <>
                  {evidence}
                  <span className="album-meta">{gap.ledger.label}</span>
                  {submissionFeedback[gap.releaseMbid] && (
                    <BotSubmissionNotice feedback={submissionFeedback[gap.releaseMbid]} />
                  )}
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

        const form = forms[gap.releaseMbid] ?? { editId: '' };
        return (
          <ConfirmDisclosure
            key={gap.releaseMbid}
            data-inbox-release={gap.releaseMbid}
            evidence={evidence}
            links={links}
            disabled={busy}
          >
            <div className="toolbar px-0">
              <button
                className="act"
                disabled={busy}
                onClick={() => navigator.clipboard.writeText(gap.barcode)}
              >
                Copy barcode
              </button>
              {bot?.configured && (
                <>
                  <button
                    className="act"
                    data-variant="primary"
                    disabled={busy}
                    onClick={() => submitBot(gap.releaseMbid, gap.releaseTitle)}
                  >
                    Confirm as prelude_fm_bot
                  </button>
                  <button
                    className="act"
                    disabled={busy}
                    onClick={() => revealPayload(gap.releaseMbid)}
                  >
                    {payload?.releaseMbid === gap.releaseMbid ? 'Hide' : 'View'} payload
                  </button>
                </>
              )}
              <input
                className="mono w-40"
                placeholder="edit ID (optional)"
                value={form.editId}
                onChange={(event) =>
                  setForms((current) => ({
                    ...current,
                    [gap.releaseMbid]: { editId: event.target.value },
                  }))
                }
              />
              <button className="act" disabled={busy} onClick={() => confirmHand(gap.releaseMbid)}>
                Confirm hand submission
              </button>
            </div>
            {payload?.releaseMbid === gap.releaseMbid && (
              <pre className="mono overflow-x-auto text-[11px] text-[var(--ink-2)]">
                {payload.xml}
              </pre>
            )}
            {submissionFeedback[gap.releaseMbid] && (
              <BotSubmissionNotice feedback={submissionFeedback[gap.releaseMbid]} />
            )}
          </ConfirmDisclosure>
        );
      })}
      <LoadMoreRows shown={rows.length} total={total} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
