'use client';

import { useState, type ReactNode } from 'react';
import { getBotPayload, submitBotBatch, type BotStatus } from '../actions/bot';
import type { ContributionView } from '../actions/inbox-view';
import {
  recheckSubmission,
  recordIsrcResubmission,
  recordIsrcSubmission,
} from '../actions/submissions';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxSection } from './InboxSection';
import { PreviousSubmission } from './PreviousSubmission';
import { RowActionStatus } from './RowActionStatus';
import { LoadMoreRows } from './LoadMoreRows';
import { BotSubmissionNotice } from './BotSubmissionNotice';
import { EditIdInput, useRowForms, useRowMutation } from './LedgerGapRow';
import { useBotSubmission } from './useBotSubmission';

type IsrcRelease = ContributionView['isrcReleases'][number];

type IsrcTrack = IsrcRelease['tracks'][number];

function IsrcTrackTable({
  tracks,
  resubmitActions,
}: {
  tracks: IsrcRelease['tracks'];
  /** Controls for a track voters rejected before; omitted in the read-only view. */
  resubmitActions?: (track: IsrcTrack) => ReactNode;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Disc/track</th>
          <th>Our track</th>
          <th>MusicBrainz recording</th>
          <th>Δ</th>
          <th>ISRC</th>
          <th>Submitted</th>
        </tr>
      </thead>
      <tbody>
        {tracks.map((track) => (
          <tr key={`${track.medium}-${track.position}`}>
            <td className="mono whitespace-nowrap">
              {track.medium}-{track.position}
            </td>
            <td>{track.trackTitle}</td>
            <td>
              <a
                href={`https://musicbrainz.org/recording/${track.recordingMbid}`}
                target="_blank"
                rel="noreferrer"
              >
                {track.recordingTitle}
              </a>
            </td>
            <td className="mono whitespace-nowrap">{track.delta}ms</td>
            <td className="mono whitespace-nowrap">{track.isrc}</td>
            <td className="album-meta whitespace-nowrap">
              {!track.ledger ? (
                track.previous ? (
                  <span className="flex flex-col items-start gap-1">
                    <PreviousSubmission previous={track.previous} />
                    {track.previous.explicitOnly && resubmitActions?.(track)}
                  </span>
                ) : (
                  'not yet submitted'
                )
              ) : track.ledger.editId ? (
                <>
                  {track.ledger.outcome} ·{' '}
                  <a
                    href={`https://musicbrainz.org/edit/${track.ledger.editId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    edit {track.ledger.editId}
                  </a>
                </>
              ) : (
                track.ledger.label
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "3 submitted (2 pending, 1 applied)", or null when nothing is submitted yet. */
function submittedSummary(tracks: IsrcRelease['tracks']): string | null {
  const byOutcome = new Map<string, number>();
  for (const track of tracks) {
    if (track.ledger) {
      byOutcome.set(track.ledger.outcome, (byOutcome.get(track.ledger.outcome) ?? 0) + 1);
    }
  }
  const submitted = [...byOutcome.values()].reduce((sum, count) => sum + count, 0);
  if (submitted === 0) return null;
  const parts = [...byOutcome].map(([outcome, count]) => `${count} ${outcome}`);
  return `${submitted} submitted (${parts.join(', ')})`;
}

export function IsrcSection({
  rows,
  trackTotal,
  releaseTotal,
  bot,
  onReload,
  onBotChange,
  onLoadMore,
}: {
  rows: ContributionView['isrcReleases'];
  trackTotal: number;
  releaseTotal: number;
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

  async function confirmHand(releaseMbid: string) {
    await mutate(releaseMbid, 'Confirming hand submission…', () =>
      recordIsrcSubmission(releaseMbid, formOf(releaseMbid)),
    );
  }

  async function submitBot(releaseMbid: string, albumTitle: string) {
    await submit(releaseMbid, submitBotBatch, {
      success: (count) =>
        `${albumTitle}: submitted ${count} ISRCs. They stay pending until MusicBrainz shows them.`,
      empty: 'No eligible ISRC was found for this release.',
    });
  }

  async function resubmitBot(releaseMbid: string, track: IsrcTrack) {
    await submit(
      releaseMbid,
      () => submitBotBatch(releaseMbid, { recordingMbid: track.recordingMbid, isrc: track.isrc }),
      {
        success: () =>
          `${track.trackTitle}: resubmitted ${track.isrc}. It stays pending until MusicBrainz shows it.`,
        empty: 'That ISRC is no longer outstanding on this release.',
      },
    );
  }

  async function resubmitHand(releaseMbid: string, track: IsrcTrack) {
    await mutate(releaseMbid, 'Confirming hand resubmission…', () =>
      recordIsrcResubmission(
        releaseMbid,
        { recordingMbid: track.recordingMbid, isrc: track.isrc },
        formOf(releaseMbid),
      ),
    );
  }

  async function revealPayload(releaseMbid: string) {
    if (payload?.releaseMbid === releaseMbid) {
      setPayload(null);
      return;
    }
    await runRow(releaseMbid, 'Loading bot payload…', async () => {
      setPayload({ releaseMbid, xml: await getBotPayload(releaseMbid) });
    });
  }

  async function recheck(releaseMbid: string) {
    await mutate(releaseMbid, 'Rechecking MusicBrainz…', () =>
      recheckSubmission({ kind: 'isrc', releaseMbid }),
    );
  }

  return (
    <InboxSection
      inboxClass="isrc"
      title="Recordings missing ISRCs"
      channel="BOT"
      total={releaseTotal}
      shown={rows.length}
      pending={pending}
      countLabel={`${trackTotal} tracks · ${releaseTotal} releases`}
      description="Each track is on the barcode-matched release, the complete tracklists align, and durations agree within three seconds."
    >
      {rows.map((release) => {
        const state = row(release.releaseMbid);
        const submitted = submittedSummary(release.tracks);
        const evidence = (
          <span className="min-w-0">
            <span className="block truncate">{release.albumTitle}</span>
            <span className="album-meta">
              {release.missing} missing
              {submitted ? ` · ${submitted}` : ''}
              {submitted && release.batch > 0 ? ` · ${release.batch} still eligible to submit` : ''}
              {release.rejected > 0
                ? ` · ${release.rejected} rejected before, resubmitted one at a time`
                : ''}
              {' · '}barcode {release.barcode ?? <span className="absent">missing</span>}
            </span>
            <RowActionStatus row={state} />
          </span>
        );
        const feedback = submissionFeedback[release.releaseMbid];
        const links = (
          <>
            {release.batch > 0 && (
              <a className="act" href={release.link} target="_blank" rel="noreferrer">
                MagicISRC
              </a>
            )}
            <a
              className="act"
              href={`https://musicbrainz.org/release/${release.releaseMbid}`}
              target="_blank"
              rel="noreferrer"
            >
              MusicBrainz
            </a>
          </>
        );

        if (release.eligible === 0) {
          return (
            <ConfirmDisclosure
              key={release.releaseMbid}
              data-inbox-release={release.releaseMbid}
              evidence={
                <>
                  {evidence}
                  {feedback && (
                    <BotSubmissionNotice
                      feedback={feedback}
                      onDismiss={() => dismissFeedback(release.releaseMbid)}
                    />
                  )}
                </>
              }
              links={links}
              label="Tracks"
              primary={false}
              extraAction={
                submitted ? (
                  <button
                    className="act"
                    disabled={state.busy}
                    onClick={() => recheck(release.releaseMbid)}
                  >
                    Recheck
                  </button>
                ) : undefined
              }
            >
              <IsrcTrackTable tracks={release.tracks} />
            </ConfirmDisclosure>
          );
        }

        return (
          <ConfirmDisclosure
            key={release.releaseMbid}
            data-inbox-release={release.releaseMbid}
            evidence={evidence}
            links={links}
          >
            <IsrcTrackTable
              tracks={release.tracks}
              resubmitActions={(track) => (
                <span className="flex gap-1">
                  {bot?.configured && (
                    <button
                      className="act"
                      disabled={state.busy}
                      onClick={() => resubmitBot(release.releaseMbid, track)}
                    >
                      Resubmit as prelude_fm_bot
                    </button>
                  )}
                  <button
                    className="act"
                    disabled={state.busy}
                    onClick={() => resubmitHand(release.releaseMbid, track)}
                  >
                    Confirm hand resubmission
                  </button>
                </span>
              )}
            />
            <p className="mt-2 text-[11px] text-[var(--faint)]">
              The release barcode is the album barcode
              {release.upc && release.upc !== release.barcode ? ` (${release.upc} padded)` : ''}.
              The bot and MagicISRC only receive rows not yet recorded as submitted, and never an
              ISRC voters rejected before: each of those goes again only from its own track.
            </p>
            <div className="toolbar px-0">
              {bot?.configured && release.batch > 0 && (
                <>
                  <button
                    className="act"
                    data-variant="primary"
                    disabled={state.busy}
                    onClick={() => submitBot(release.releaseMbid, release.albumTitle)}
                  >
                    Confirm {release.batch} as prelude_fm_bot
                  </button>
                  <button
                    className="act"
                    disabled={state.busy}
                    onClick={() => revealPayload(release.releaseMbid)}
                  >
                    {payload?.releaseMbid === release.releaseMbid ? 'Hide' : 'View'} payload
                  </button>
                </>
              )}
              <EditIdInput
                value={formOf(release.releaseMbid).editId}
                onChange={(editId) => setForm(release.releaseMbid, { editId })}
              />
              {release.batch > 0 && (
                <button
                  className="act"
                  disabled={state.busy}
                  onClick={() => confirmHand(release.releaseMbid)}
                >
                  Confirm hand submission
                </button>
              )}
            </div>
            {payload?.releaseMbid === release.releaseMbid && (
              <pre className="mono overflow-x-auto text-[11px] text-[var(--ink-2)]">
                {payload.xml}
              </pre>
            )}
            {feedback && (
              <BotSubmissionNotice
                feedback={feedback}
                onDismiss={() => dismissFeedback(release.releaseMbid)}
              />
            )}
          </ConfirmDisclosure>
        );
      })}
      <LoadMoreRows shown={rows.length} total={releaseTotal} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
