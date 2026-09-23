'use client';

import { useState } from 'react';
import { useAdminFailure } from '../components/AdminFailure';
import {
  recordMisalignedTracklistReport,
  recheckErrorReport,
  type ContributionView,
} from '../actions/contribute';
import type { InboxClass } from '../lib/admin-url';
import { ConfirmDisclosure } from './ConfirmDisclosure';
import { InboxRow } from './InboxRow';
import { InboxSection } from './InboxSection';
import { LoadMoreRows } from './LoadMoreRows';

export function MisalignedSection({
  rows,
  total,
  activeClass,
  onReload,
  onLoadMore,
}: {
  rows: ContributionView['misaligned'];
  total: number;
  activeClass?: InboxClass;
  onReload: () => Promise<void>;
  onLoadMore: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { clearFailure, showFailure } = useAdminFailure();
  const [forms, setForms] = useState<Record<string, { editId: string }>>({});

  async function confirm(albumId: string, disposition: 'reported' | 'fixed') {
    clearFailure();
    setBusy(true);
    try {
      await recordMisalignedTracklistReport(albumId, disposition, forms[albumId] ?? { editId: '' });
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function recheck(albumId: string) {
    clearFailure();
    setBusy(true);
    try {
      await recheckErrorReport('misaligned_tracklist', albumId);
      await onReload();
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <InboxSection
      inboxClass="misaligned"
      activeClass={activeClass}
      title="Tracklists that do not line up"
      channel="REPORT"
      total={total}
      shown={rows.length}
      description="Both tracklists stay visible because the error may be in either source. Reporting records the decision; it does not alter the cached tracklist."
    >
      {rows.map((album) => {
        const diagnosis =
          album.diagnosis.kind === 'reordered'
            ? 'same recordings, different order'
            : album.diagnosis.kind === 'different-length'
              ? `${album.ourCount} tracks here, ${album.theirCount} on the release`
              : 'durations do not correspond';
        const evidence = (
          <span className="min-w-0">
            <span className="block truncate">{album.albumTitle}</span>
            <span className="album-meta">
              {diagnosis}
              {album.anchoredByIsrc > 0 && ` · ${album.anchoredByIsrc} anchored by ISRC regardless`}
            </span>
          </span>
        );
        const links = (
          <>
            <a
              className="act"
              href={`https://musicbrainz.org/release/${album.releaseMbid}`}
              target="_blank"
              rel="noreferrer"
            >
              MusicBrainz
            </a>
            <a
              className="act"
              href={`https://open.spotify.com/album/${album.albumId}`}
              target="_blank"
              rel="noreferrer"
            >
              Spotify
            </a>
          </>
        );

        if (album.ledger) {
          return (
            <InboxRow
              key={album.albumId}
              data-inbox-album={album.albumId}
              evidence={
                <>
                  {evidence}
                  <span className="album-meta">
                    {album.ledger.disposition} · {album.ledger.label}
                  </span>
                </>
              }
              links={links}
              action={
                <button className="act" disabled={busy} onClick={() => recheck(album.albumId)}>
                  Recheck
                </button>
              }
            />
          );
        }

        const form = forms[album.albumId] ?? { editId: '' };
        return (
          <ConfirmDisclosure
            key={album.albumId}
            data-inbox-album={album.albumId}
            evidence={evidence}
            links={links}
            disabled={busy}
          >
            <table>
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Ours</th>
                  <th>MusicBrainz</th>
                </tr>
              </thead>
              <tbody>
                {album.mismatches.map((row) => (
                  <tr key={row.position}>
                    <td className="mono">{row.position}</td>
                    <td>
                      {row.ourTitle ?? <span className="absent">missing</span>}
                      {row.ourMs !== null && (
                        <span className="mono block text-[11px] text-[var(--faint)]">
                          {row.ourMs}ms
                        </span>
                      )}
                    </td>
                    <td>
                      {row.theirTitle ?? <span className="absent">missing</span>}
                      {row.theirMs !== null && (
                        <span className="mono block text-[11px] text-[var(--faint)]">
                          {row.theirMs}ms
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="toolbar px-0">
              <a
                className="act"
                href={`https://musicbrainz.org/release/${album.releaseMbid}/edit`}
                target="_blank"
                rel="noreferrer"
              >
                Edit release
              </a>
              <input
                className="mono w-40"
                placeholder="edit ID (optional)"
                value={form.editId}
                onChange={(event) =>
                  setForms((current) => ({
                    ...current,
                    [album.albumId]: { editId: event.target.value },
                  }))
                }
              />
              <button
                className="act"
                data-variant="primary"
                disabled={busy}
                onClick={() => confirm(album.albumId, 'reported')}
              >
                Confirm report
              </button>
              <button
                className="act"
                disabled={busy}
                onClick={() => confirm(album.albumId, 'fixed')}
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
