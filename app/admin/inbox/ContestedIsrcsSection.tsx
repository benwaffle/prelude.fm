'use client';

import { useState } from 'react';
import { useAdminAction } from '../components/useAdminAction';
import {
  recordContestedIsrcReport,
  recheckErrorReport,
  type ContributionView,
} from '../actions/contribute';
import type { InboxClass } from '../lib/admin-url';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
import { PreviousSubmission } from './PreviousSubmission';
import { RowActionStatus } from './RowActionStatus';
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
  const { pending, busy, runRow, row: rowAction } = useAdminAction();
  const [forms, setForms] = useState<Record<string, { editId: string }>>({});

  async function confirm(isrc: string, disposition: 'reported' | 'fixed') {
    await runRow(isrc, 'Confirming submission…', async () => {
      await recordContestedIsrcReport(isrc, disposition, forms[isrc] ?? { editId: '' });
      await onReload();
    });
  }

  async function recheck(isrc: string) {
    await runRow(isrc, 'Rechecking MusicBrainz…', async () => {
      await recheckErrorReport('contested_isrc', isrc);
      await onReload();
    });
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
        const state = rowAction(row.isrc);
        const evidence = (
          <span className="min-w-0">
            <span className="mono block">{row.isrc}</span>
            <span className="block text-[11px] text-[var(--ink-2)]">{row.titles}</span>
            {row.judgement && <ContestedVerdict judgement={row.judgement} />}
            <span className="album-meta">
              {row.recordingMbids.map((mbid) => (
                <span key={mbid} className="mono">
                  {mbid}
                </span>
              ))}
            </span>
            {!row.ledger && row.previous && <PreviousSubmission previous={row.previous} />}
            <RowActionStatus row={state} />
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
                <button className="act" disabled={state.busy} onClick={() => recheck(row.isrc)}>
                  Recheck
                </button>
              }
            />
          );
        }

        const form = forms[row.isrc] ?? { editId: '' };
        return (
          <ConfirmDisclosure key={row.isrc} evidence={evidence} links={links}>
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
                disabled={state.busy}
                onClick={() => confirm(row.isrc, 'reported')}
              >
                Confirm report
              </button>
              <button
                className="act"
                disabled={state.busy}
                onClick={() => confirm(row.isrc, 'fixed')}
              >
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

type Judgement = NonNullable<ContributionView['contested'][number]['judgement']>;

function RecordingName({ judgement, mbid }: { judgement: Judgement; mbid: string }) {
  const claimant = judgement.claimants.find((entry) => entry.recordingMbid === mbid);
  return (
    <a href={`https://musicbrainz.org/recording/${mbid}`} target="_blank" rel="noreferrer">
      {claimant?.title ?? <span className="mono">{mbid}</span>}
      {claimant?.lengthMs != null && ` (${formatLength(claimant.lengthMs)})`}
    </a>
  );
}

function formatLength(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function RecordingList({ judgement, mbids }: { judgement: Judgement; mbids: string[] }) {
  return (
    <>
      {mbids.map((mbid, index) => (
        <span key={mbid}>
          {index > 0 && '; '}
          <RecordingName judgement={judgement} mbid={mbid} />
        </span>
      ))}
    </>
  );
}

/** What the library says about which recording keeps the ISRC. */
function ContestedVerdict({ judgement }: { judgement: Judgement }) {
  const { verdict } = judgement;
  const lines: React.ReactNode[] = [];
  if (verdict.kind === 'owner') {
    lines.push(
      verdict.basis === 'release-position' ? (
        <>
          Belongs to <RecordingName judgement={judgement} mbid={verdict.ownerMbid} />: a library
          track with this ISRC sits at that recording&apos;s place on its own release, and the
          lengths match.
        </>
      ) : (
        <>
          Probably <RecordingName judgement={judgement} mbid={verdict.ownerMbid} />: the only one
          that runs the length of the library track with this ISRC. That track could not be placed
          on its release, so this is weaker.
        </>
      ),
    );
    if (verdict.remove.length > 0) {
      lines.push(
        <>
          Remove the ISRC from <RecordingList judgement={judgement} mbids={verdict.remove} />.
        </>,
      );
    }
    if (verdict.duplicates.length > 0) {
      lines.push(
        <>
          Same length and no ISRC of its own, so likely the same performance entered twice; merge:{' '}
          <RecordingList judgement={judgement} mbids={verdict.duplicates} />.
        </>,
      );
    }
    if (verdict.unclear.length > 0) {
      lines.push(
        <>
          No evidence either way for <RecordingList judgement={judgement} mbids={verdict.unclear} />
          .
        </>,
      );
    }
  } else if (verdict.kind === 'stray') {
    lines.push(
      <>
        No library track carries this ISRC, and each of these recordings already has its own ISRC on
        a Spotify track. It looks wrongly added to all of them.
      </>,
    );
  } else {
    lines.push(<>Undecided: {verdict.reason}.</>);
  }
  return (
    <span className="block text-[11px]">
      {lines.map((line, index) => (
        <span key={index} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}
