'use client';

import { useState } from 'react';
import { getBarcodeBotPayload, submitBarcodeBotBatch, type BotStatus } from '../actions/bot';
import type { ContributionView } from '../actions/inbox-view';
import { recheckSubmission, recordBarcodeSubmission } from '../actions/submissions';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';
import { BotSubmissionNotice } from './BotSubmissionNotice';
import { Notice } from '../components/Notice';
import { useBotSubmission } from './useBotSubmission';
import {
  EditIdInput,
  GapEvidence,
  LedgerGapRow,
  useRowForms,
  useRowMutation,
} from './LedgerGapRow';

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
  onReload,
  onBotChange,
  onLoadMore,
}: {
  rows: ContributionView['barcodes'];
  total: number;
  bot: BotStatus | null;
  onReload: () => Promise<void>;
  onBotChange: (bot: BotStatus) => void;
  onLoadMore: () => void;
}) {
  const { pending, busy, runRow, row, mutate } = useRowMutation(onReload);
  const { formOf, setForm } = useRowForms({ editId: '' });
  const [payload, setPayload] = useState<{ releaseMbid: string; xml: string } | null>(null);
  const {
    feedback: submissionFeedback,
    submit,
    dismiss: dismissFeedback,
  } = useBotSubmission({ runRow, onBotChange, onReload });

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

  return (
    <InboxSection
      inboxClass="barcodes"
      title="Releases with no barcode"
      channel="BOT"
      total={total}
      shown={rows.length}
      pending={pending}
      description="These releases were matched by title and duration. The Spotify barcode is shown as evidence and stays pending until the cache holds it."
    >
      {rows.map((gap) => {
        const key = gap.releaseMbid;
        const state = row(key);
        const feedback = submissionFeedback[key] && (
          <BotSubmissionNotice
            feedback={submissionFeedback[key]}
            onDismiss={() => dismissFeedback(key)}
          />
        );
        return (
          <LedgerGapRow
            key={key}
            data-inbox-release={gap.releaseMbid}
            ledger={gap.ledger}
            busy={state.busy}
            onRecheck={() =>
              mutate(key, 'Rechecking MusicBrainz…', () =>
                recheckSubmission({ kind: 'barcode', releaseMbid: gap.releaseMbid }),
              )
            }
            evidence={
              <GapEvidence ledger={gap.ledger} previous={gap.previous} state={state}>
                <span className="block truncate">{gap.releaseTitle}</span>
                <span className="album-meta">
                  title matched · {gap.trackCount} tracks · worst duration difference{' '}
                  {gap.maxDurationDeltaMs}ms
                </span>
                <code className="mono block select-all text-[11px] text-[var(--ink-2)]">
                  {gap.barcode}
                </code>
              </GapEvidence>
            }
            links={
              <a className="act" href={gap.edit} target="_blank" rel="noreferrer">
                MusicBrainz
              </a>
            }
            ledgerNote={
              gap.ledger && (
                <>
                  <span className="album-meta">{gap.ledger.label}</span>
                  {gap.ledger.unsentNote && (
                    <UnsentBarcodeNote releaseMbid={gap.releaseMbid} note={gap.ledger.unsentNote} />
                  )}
                  {feedback}
                </>
              )
            }
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
                    {gap.previous?.explicitOnly ? 'Resubmit' : 'Confirm'} as prelude_fm_bot
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
              <EditIdInput
                value={formOf(key).editId}
                onChange={(editId) => setForm(key, { editId })}
              />
              <button
                className="act"
                disabled={state.busy}
                onClick={() =>
                  mutate(key, 'Confirming hand submission…', () =>
                    recordBarcodeSubmission(gap.releaseMbid, formOf(key)),
                  )
                }
              >
                Confirm hand submission
              </button>
            </div>
            {payload?.releaseMbid === gap.releaseMbid && (
              <pre className="mono overflow-x-auto text-[11px] text-[var(--ink-2)]">
                {payload.xml}
              </pre>
            )}
            {feedback}
          </LedgerGapRow>
        );
      })}
      <LoadMoreRows shown={rows.length} total={total} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
