'use client';

import { useState } from 'react';
import { useAdminAction } from '../components/useAdminAction';
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
import { RowActionStatus } from './RowActionStatus';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';
import { BotSubmissionNotice } from './BotSubmissionNotice';
import { Notice } from '../components/Notice';
import { useBotSubmission } from './useBotSubmission';

/**
 * MusicBrainz drops the note on barcode edits sent through its API
 * (MBS-14476), so the edit went in without one. Show it for adding by hand.
 */
function UnsentBarcodeNote({ releaseMbid, note }: { releaseMbid: string; note: string }) {
  return (
    <Notice intent="info">
      <p>
        MusicBrainz did not attach this note to the barcode edit. Add it by hand from the{' '}
        <a
          className="underline"
          href={`https://musicbrainz.org/release/${releaseMbid}/edits`}
          target="_blank"
          rel="noreferrer"
        >
          release&rsquo;s edit history
        </a>
        .
      </p>
      <pre className="mono mt-2 whitespace-pre-wrap break-words text-[11px]">{note}</pre>
      <button className="act mt-2" onClick={() => navigator.clipboard.writeText(note)}>
        Copy note
      </button>
    </Notice>
  );
}

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
  const { pending, busy, runRow, row } = useAdminAction();
  const [forms, setForms] = useState<Record<string, { editId: string }>>({});
  const [payload, setPayload] = useState<{ releaseMbid: string; xml: string } | null>(null);
  const {
    feedback: submissionFeedback,
    submit,
    dismiss: dismissFeedback,
  } = useBotSubmission({ runRow, onBotChange, onReload });

  async function confirmHand(releaseMbid: string) {
    await runRow(releaseMbid, 'Confirming hand submission…', async () => {
      await recordBarcodeSubmission(releaseMbid, forms[releaseMbid] ?? { editId: '' });
      await onReload();
    });
  }

  async function submitBot(releaseMbid: string, releaseTitle: string) {
    await submit(releaseMbid, submitBarcodeBotBatch, {
      success: () =>
        `${releaseTitle}: submitted barcode. It stays pending until MusicBrainz shows it.`,
      empty: 'No eligible barcode was found for this release.',
    });
  }

  async function revealPayload(releaseMbid: string) {
    if (payload?.releaseMbid === releaseMbid) {
      setPayload(null);
      return;
    }
    await runRow(releaseMbid, 'Loading bot payload…', async () => {
      setPayload({ releaseMbid, xml: await getBarcodeBotPayload(releaseMbid) });
    });
  }

  async function recheck(releaseMbid: string) {
    await runRow(releaseMbid, 'Rechecking MusicBrainz…', async () => {
      await recheckBarcode(releaseMbid);
      await onReload();
    });
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
        const state = row(gap.releaseMbid);
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
              key={gap.releaseMbid}
              data-inbox-release={gap.releaseMbid}
              evidence={
                <>
                  {evidence}
                  <span className="album-meta">{gap.ledger.label}</span>
                  {gap.ledger.unsentNote && (
                    <UnsentBarcodeNote releaseMbid={gap.releaseMbid} note={gap.ledger.unsentNote} />
                  )}
                  {submissionFeedback[gap.releaseMbid] && (
                    <BotSubmissionNotice
                      feedback={submissionFeedback[gap.releaseMbid]}
                      onDismiss={() => dismissFeedback(gap.releaseMbid)}
                    />
                  )}
                </>
              }
              links={links}
              action={
                <button
                  className="act"
                  disabled={state.busy}
                  onClick={() => recheck(gap.releaseMbid)}
                >
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
          >
            <div className="toolbar px-0">
              <button
                className="act"
                disabled={state.busy}
                onClick={() => navigator.clipboard.writeText(gap.barcode)}
              >
                Copy barcode
              </button>
              {bot?.configured && (
                <>
                  <button
                    className="act"
                    data-variant="primary"
                    disabled={state.busy}
                    onClick={() => submitBot(gap.releaseMbid, gap.releaseTitle)}
                  >
                    Confirm as prelude_fm_bot
                  </button>
                  <button
                    className="act"
                    disabled={state.busy}
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
              <button
                className="act"
                disabled={state.busy}
                onClick={() => confirmHand(gap.releaseMbid)}
              >
                Confirm hand submission
              </button>
            </div>
            {payload?.releaseMbid === gap.releaseMbid && (
              <pre className="mono overflow-x-auto text-[11px] text-[var(--ink-2)]">
                {payload.xml}
              </pre>
            )}
            {submissionFeedback[gap.releaseMbid] && (
              <BotSubmissionNotice
                feedback={submissionFeedback[gap.releaseMbid]}
                onDismiss={() => dismissFeedback(gap.releaseMbid)}
              />
            )}
          </ConfirmDisclosure>
        );
      })}
      <LoadMoreRows shown={rows.length} total={total} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
