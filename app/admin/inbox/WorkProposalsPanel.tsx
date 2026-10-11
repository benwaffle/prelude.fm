'use client';

import { useEffect, useState } from 'react';
import {
  decideWorkProposals,
  getWorkProposals,
  recordEnteredWorkLinks,
  type WorkProposalsView,
} from '../actions/work-proposals';
import { adminFailureMessage } from '../components/AdminFailure';
import { useAdminAction } from '../components/useAdminAction';
import type { ProposalAlbumView, ProposalRowView } from '@/lib/work-proposals-view';
import { relationshipEditorUrl } from '@/lib/work-proposals-view';
import type { ProposalConfidence } from '@/lib/work-proposals';

const STATE_LABEL: Record<ProposalRowView['state'], string> = {
  unchecked: 'not checked yet',
  none: 'no proposal',
  proposed: 'proposed',
  approved: 'approved, enter on MusicBrainz',
  dismissed: 'dismissed',
};

function workUrl(workMbid: string) {
  return `https://musicbrainz.org/work/${workMbid}`;
}

/**
 * Proposed work links, approved in batches.
 *
 * Approving records only that you agree. The edit itself is made in
 * MusicBrainz's relationship editor, one album at a time; then "Record as
 * entered" writes the ledger rows the section below rechecks.
 */
export function WorkProposalsPanel({ onRecorded }: { onRecorded: () => Promise<void> }) {
  const [view, setView] = useState<WorkProposalsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);
  const { pending, busy, run } = useAdminAction();

  useEffect(() => {
    let cancelled = false;
    getWorkProposals()
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(adminFailureMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function decide(recordingMbids: string[], status: 'approved' | 'dismissed' | 'proposed') {
    if (recordingMbids.length === 0) return;
    const label =
      status === 'approved'
        ? `Approving ${recordingMbids.length}…`
        : status === 'dismissed'
          ? `Dismissing ${recordingMbids.length}…`
          : `Reopening ${recordingMbids.length}…`;
    await run(label, async () => {
      setView(await decideWorkProposals(recordingMbids, status));
      setSelected(new Set());
    });
  }

  async function recordEntered(album: ProposalAlbumView) {
    await run(`Recording ${album.albumTitle}…`, async () => {
      setView(await recordEnteredWorkLinks(album.albumId));
      await onRecorded();
    });
  }

  if (loadError) {
    return <p className="absent px-4 py-3">Proposed work links could not be loaded: {loadError}</p>;
  }
  if (!view) return <p className="album-meta px-4 py-3">Loading proposed work links…</p>;

  const { counts } = view;
  const highProposed = view.albums.flatMap((album) =>
    album.rows
      .filter((row) => row.state === 'proposed' && row.proposal?.confidence === 'high')
      .map((row) => row.recordingMbid),
  );
  const toggle = (recordingMbid: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(recordingMbid)) next.delete(recordingMbid);
      else next.add(recordingMbid);
      return next;
    });
  const select = (rows: ProposalRowView[], confidence?: ProposalConfidence) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const row of rows) {
        if (row.state !== 'proposed') continue;
        if (confidence && row.proposal?.confidence !== confidence) continue;
        next.add(row.recordingMbid);
      }
      return next;
    });

  return (
    <div className="border-b border-[var(--rule)] px-4 py-3">
      <div className="toolbar px-0">
        <span className="eyebrow">Proposed work links</span>
        <span className="album-meta">
          {counts.high} high · {counts.medium} medium · {counts.low} low to decide ·{' '}
          {counts.approved} approved · {counts.dismissed} dismissed · {counts.none} with no proposal
          {counts.unchecked > 0 && ` · ${counts.unchecked} not checked yet`}
        </span>
        <button
          className="act"
          data-variant="primary"
          disabled={busy || highProposed.length === 0}
          onClick={() => decide(highProposed, 'approved')}
        >
          Approve all high ({highProposed.length})
        </button>
        <button
          className="act"
          disabled={busy || selected.size === 0}
          onClick={() => decide([...selected], 'approved')}
        >
          Approve selected ({selected.size})
        </button>
        <button
          className="act"
          disabled={busy || selected.size === 0}
          onClick={() => decide([...selected], 'dismissed')}
        >
          Dismiss selected
        </button>
        <label className="album-meta flex items-center gap-1">
          <input
            type="checkbox"
            checked={showDismissed}
            onChange={(event) => setShowDismissed(event.target.checked)}
          />
          show dismissed
        </label>
      </div>
      {pending && <p className="album-meta">{pending}</p>}
      <p className="album-meta mb-2">
        Approving only records that you agree. Enter approved links in the album&apos;s MusicBrainz
        relationship editor: copy a work link here, paste it into that track&apos;s “Add
        relationship” search, submit there, then record them as entered here.
        {counts.unchecked > 0 && ' Run pnpm metadata:work-proposals to check the rest.'}
      </p>

      {view.albums.map((album) => {
        const rows = album.rows.filter((row) => showDismissed || row.state !== 'dismissed');
        if (rows.length === 0) return null;
        const approved = rows.filter((row) => row.state === 'approved').length;
        const deciding = rows.filter((row) => row.state === 'proposed').length;
        return (
          <details key={album.albumId} className="fold mb-2" open={approved > 0}>
            <summary>
              {album.albumTitle} · {deciding} to decide
              {approved > 0 && ` · ${approved} approved`}
            </summary>
            <div className="fold-body">
              <div className="toolbar px-0">
                {album.releaseMbid ? (
                  <a
                    className="act"
                    href={relationshipEditorUrl(album.releaseMbid)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Relationship editor
                  </a>
                ) : (
                  <span className="absent">No MusicBrainz release cached for this album</span>
                )}
                <button
                  className="act"
                  disabled={busy || deciding === 0}
                  onClick={() => select(rows, 'high')}
                >
                  Select high
                </button>
                <button
                  className="act"
                  disabled={busy || deciding === 0}
                  onClick={() => select(rows)}
                >
                  Select all
                </button>
                <button
                  className="act"
                  disabled={approved === 0}
                  onClick={() =>
                    navigator.clipboard.writeText(
                      rows
                        .filter((row) => row.state === 'approved' && row.proposal)
                        .map((row) => workUrl(row.proposal!.workMbid))
                        .join('\n'),
                    )
                  }
                >
                  Copy {approved} approved work links
                </button>
                <button
                  className="act"
                  data-variant="primary"
                  disabled={busy || approved === 0}
                  onClick={() => recordEntered(album)}
                >
                  Record {approved} as entered
                </button>
              </div>
              {rows.map((row) => (
                <ProposalRow
                  key={row.recordingMbid}
                  row={row}
                  checked={selected.has(row.recordingMbid)}
                  busy={busy}
                  onToggle={() => toggle(row.recordingMbid)}
                  onReopen={() => decide([row.recordingMbid], 'proposed')}
                />
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ProposalRow({
  row,
  checked,
  busy,
  onToggle,
  onReopen,
}: {
  row: ProposalRowView;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
  onReopen: () => void;
}) {
  const proposal = row.proposal;
  const position =
    row.position !== null
      ? `${row.medium && row.medium > 1 ? `${row.medium}-` : ''}${row.position}`
      : '';
  return (
    <div className="inbox-row items-start">
      <div className="inbox-evidence min-w-0">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            disabled={busy || row.state !== 'proposed'}
            checked={checked}
            onChange={onToggle}
            aria-label={`Select ${row.title}`}
          />
          <span className="min-w-0">
            <span className="block">
              <span className="mono text-[var(--faint)]">{position}</span> {row.title}
            </span>
            {proposal ? (
              <span className="block">
                →{' '}
                <a href={workUrl(proposal.workMbid)} target="_blank" rel="noreferrer">
                  {proposal.parentTitle ? `${proposal.parentTitle}: ` : ''}
                  {proposal.title}
                </a>{' '}
                <span className="tag">{proposal.confidence}</span>
                <span className="album-meta block">
                  {proposal.composerName ?? 'no composer on MusicBrainz'} ·{' '}
                  {proposal.reasons.join(' ')}
                </span>
              </span>
            ) : (
              <span className="absent block">{STATE_LABEL[row.state]}</span>
            )}
          </span>
        </label>
      </div>
      <div className="inbox-links">
        {proposal && (
          <span className="album-meta">
            {STATE_LABEL[row.state]}
            {row.state === 'approved' && (
              <>
                {' · '}
                <button
                  className="act"
                  onClick={() => navigator.clipboard.writeText(workUrl(proposal.workMbid))}
                >
                  Copy link
                </button>
              </>
            )}
            {(row.state === 'approved' || row.state === 'dismissed') && (
              <>
                {' · '}
                <button className="act" disabled={busy} onClick={onReopen}>
                  Undo
                </button>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
