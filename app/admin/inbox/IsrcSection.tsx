'use client';

import { useState } from 'react';
import { useAdminFailure } from '../components/AdminFailure';
import {
  getBotPayload,
  getBotStatus,
  recordIsrcSubmission,
  recheckIsrcRelease,
  submitBotBatch,
  type BotStatus,
  type ContributionView,
} from '../actions/contribute';
import type { InboxClass } from '../lib/admin-url';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';

export function IsrcSection({
  rows,
  trackTotal,
  releaseTotal,
  bot,
  activeClass,
  onReload,
  onBotChange,
  onLoadMore,
}: {
  rows: ContributionView['isrcReleases'];
  trackTotal: number;
  releaseTotal: number;
  bot: BotStatus | null;
  activeClass?: InboxClass;
  onReload: () => Promise<void>;
  onBotChange: (bot: BotStatus, result: string) => void;
  onLoadMore: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { clearFailure, showFailure } = useAdminFailure();
  const [forms, setForms] = useState<Record<string, { editId: string }>>({});
  const [payload, setPayload] = useState<{ releaseMbid: string; xml: string } | null>(null);

  async function confirmHand(releaseMbid: string) {
    clearFailure();
    setBusy(true);
    try {
      await recordIsrcSubmission(releaseMbid, forms[releaseMbid] ?? { editId: '' });
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function submitBot(releaseMbid: string, albumTitle: string) {
    clearFailure();
    setBusy(true);
    try {
      const result = await submitBotBatch(releaseMbid);
      await onReload();
      onBotChange(
        await getBotStatus(),
        result.error
          ? `${albumTitle}: not submitted — ${result.error}`
          : `${albumTitle}: submitted ${result.submitted} ISRCs. They stay pending until MusicBrainz shows them.`,
      );
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function revealPayload(releaseMbid: string) {
    if (payload?.releaseMbid === releaseMbid) {
      setPayload(null);
      return;
    }
    clearFailure();
    setBusy(true);
    try {
      setPayload({ releaseMbid, xml: await getBotPayload(releaseMbid) });
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function recheck(releaseMbid: string) {
    clearFailure();
    setBusy(true);
    try {
      await recheckIsrcRelease(releaseMbid);
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <InboxSection
      inboxClass="isrc"
      activeClass={activeClass}
      title="Recordings missing ISRCs"
      channel="BOT"
      total={releaseTotal}
      shown={rows.length}
      countLabel={`${trackTotal} tracks · ${releaseTotal} releases`}
      description="Each track is on the barcode-matched release, the complete tracklists align, and durations agree within three seconds."
    >
      {rows.map((release) => {
        const hasLedger = release.tracks.some((track) => track.ledger);
        const evidence = (
          <span className="min-w-0">
            <span className="block truncate">{release.albumTitle}</span>
            <span className="album-meta">
              {release.missing} missing
              {release.eligible < release.missing
                ? ` · ${release.eligible} still eligible to submit`
                : ''}
              {' · '}barcode {release.barcode ?? <span className="absent">missing</span>}
            </span>
          </span>
        );
        const links = (
          <>
            {release.eligible > 0 && (
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
            <InboxRow
              key={release.releaseMbid}
              data-inbox-release={release.releaseMbid}
              evidence={evidence}
              links={links}
              action={
                hasLedger ? (
                  <button
                    className="act"
                    disabled={busy}
                    onClick={() => recheck(release.releaseMbid)}
                  >
                    Recheck
                  </button>
                ) : undefined
              }
            />
          );
        }

        const form = forms[release.releaseMbid] ?? { editId: '' };
        return (
          <ConfirmDisclosure
            key={release.releaseMbid}
            data-inbox-release={release.releaseMbid}
            evidence={evidence}
            links={links}
            disabled={busy}
          >
            <table>
              <thead>
                <tr>
                  <th>Disc/track</th>
                  <th>Our track</th>
                  <th>MusicBrainz recording</th>
                  <th>Δ</th>
                  <th>ISRC</th>
                  <th>Ledger</th>
                </tr>
              </thead>
              <tbody>
                {release.tracks.map((track) => (
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
                    <td className="album-meta whitespace-nowrap">{track.ledger?.label ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-[var(--faint)]">
              The release barcode is the album barcode
              {release.upc && release.upc !== release.barcode ? ` (${release.upc} padded)` : ''}.
              The bot and MagicISRC only receive rows not already in the ledger.
            </p>
            <div className="toolbar px-0">
              {bot?.configured && (
                <>
                  <button
                    className="act"
                    data-variant="primary"
                    disabled={busy}
                    onClick={() => submitBot(release.releaseMbid, release.albumTitle)}
                  >
                    Confirm {release.eligible} as prelude_fm_bot
                  </button>
                  <button
                    className="act"
                    disabled={busy}
                    onClick={() => revealPayload(release.releaseMbid)}
                  >
                    {payload?.releaseMbid === release.releaseMbid ? 'Hide' : 'View'} payload
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
                    [release.releaseMbid]: { editId: event.target.value },
                  }))
                }
              />
              <button
                className="act"
                disabled={busy}
                onClick={() => confirmHand(release.releaseMbid)}
              >
                Confirm hand submission
              </button>
            </div>
            {payload?.releaseMbid === release.releaseMbid && (
              <pre className="mono overflow-x-auto text-[11px] text-[var(--ink-2)]">
                {payload.xml}
              </pre>
            )}
          </ConfirmDisclosure>
        );
      })}
      <LoadMoreRows shown={rows.length} total={releaseTotal} busy={busy} onMore={onLoadMore} />
    </InboxSection>
  );
}
