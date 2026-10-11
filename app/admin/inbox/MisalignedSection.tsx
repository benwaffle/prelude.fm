'use client';

import type { ContributionView } from '../actions/inbox-view';
import { recordMisalignedTracklistReport } from '../actions/submissions';
import { ErrorReportSection } from './ErrorReportSection';

type MisalignedAlbum = ContributionView['misaligned'][number];

function describeDiagnosis(album: MisalignedAlbum): string {
  return album.diagnosis.kind === 'reordered'
    ? 'same recordings, different order'
    : album.diagnosis.kind === 'different-length'
      ? `${album.ourCount} tracks here, ${album.theirCount} on the release`
      : 'durations do not correspond';
}

export function MisalignedSection({
  rows,
  total,
  onReload,
  onLoadMore,
}: {
  rows: ContributionView['misaligned'];
  total: number;
  onReload: () => Promise<void>;
  onLoadMore: () => void;
}) {
  return (
    <ErrorReportSection
      inboxClass="misaligned"
      title="Tracklists that do not line up"
      description="Both tracklists stay visible because the error may be in either source. Reporting records the decision; it does not alter the cached tracklist."
      rows={rows}
      total={total}
      onReload={onReload}
      onLoadMore={onLoadMore}
      keyOf={(album) => album.albumId}
      rowProps={(album) => ({ 'data-inbox-album': album.albumId })}
      record={recordMisalignedTracklistReport}
      evidence={(album) => (
        <>
          <span className="block truncate">{album.albumTitle}</span>
          <span className="album-meta">
            {describeDiagnosis(album)}
            {album.anchoredByIsrc > 0 && ` · ${album.anchoredByIsrc} anchored by ISRC regardless`}
          </span>
        </>
      )}
      links={(album) => (
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
      )}
      details={(album) => (
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
      )}
      tools={(album) => (
        <a
          className="act"
          href={`https://musicbrainz.org/release/${album.releaseMbid}/edit`}
          target="_blank"
          rel="noreferrer"
        >
          Edit release
        </a>
      )}
    />
  );
}
