'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useServerQuery } from '@/lib/use-server-query';
import {
  getMatchDebug,
  type MatchDebugAlbum,
  type MatchDebugTrack,
  type MatchDebugWork,
} from '../actions/match-debug';
import { adminHref } from '../lib/admin-url';
import { Spinner } from '../components/Spinner';

const MATCHED_BY: Record<string, string> = {
  isrc: 'ISRC',
  release_position: 'position',
  reordered_title_duration: 'title+length',
};

const MB = 'https://musicbrainz.org';

export function MatchDebugTab() {
  const router = useRouter();
  const query = useSearchParams().get('q')?.trim() ?? '';
  const [input, setInput] = useState(query);
  const [heldOnly, setHeldOnly] = useState(false);
  const result = useServerQuery(query ? () => getMatchDebug(query) : null, [query]);

  const search = () =>
    router.push(`${adminHref('matches')}&q=${encodeURIComponent(input.trim())}`, {
      scroll: false,
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="toolbar">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && input.trim()) search();
          }}
          placeholder="Album, track or work title; Spotify link; MusicBrainz link; ISRC; barcode"
          className="min-w-[260px] flex-1"
        />
        <button className="act" onClick={search} disabled={!input.trim()}>
          Search
        </button>
        <label className="flex items-center gap-1 text-[11px] text-[var(--ink-2)]">
          <input
            type="checkbox"
            checked={heldOnly}
            onChange={(event) => setHeldOnly(event.target.checked)}
          />
          Only tracks not ready
        </label>
      </div>
      {query && result.status === 'loading' && <Spinner className="h-4 w-4" />}
      {result.status === 'error' && (
        <p className="text-xs text-[var(--gall)]">
          {result.message}{' '}
          <button className="act" onClick={result.retry}>
            Retry
          </button>
        </p>
      )}
      {result.status === 'ready' && result.data && (
        <>
          <p className="text-[11px] text-[var(--ink-2)]">
            {result.data.truncated
              ? `First ${result.data.tracks} matching tracks`
              : `${result.data.tracks} tracks`}{' '}
            on {result.data.albums.length} albums (searched as {result.data.query}).
          </p>
          {result.data.albums.length > 0 && (
            <div className="slip overflow-x-auto">
              <table className="match-debug text-[11px]">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Spotify track</th>
                    <th>ISRC</th>
                    <th>Recording</th>
                    <th>Work</th>
                    <th>Composer</th>
                    <th>Classical</th>
                    <th>Status</th>
                    <th>Queue</th>
                  </tr>
                </thead>
                {result.data.albums.map((album) => (
                  <AlbumRows key={album.spotifyAlbumId} album={album} heldOnly={heldOnly} />
                ))}
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AlbumRows({ album, heldOnly }: { album: MatchDebugAlbum; heldOnly: boolean }) {
  const tracks = heldOnly
    ? album.tracks.filter((track) => track.verdict.state === 'held')
    : album.tracks;
  if (tracks.length === 0) return null;
  const { release } = album;
  return (
    <tbody>
      <tr className="album-head">
        <td colSpan={9}>
          <a href={`https://open.spotify.com/album/${album.spotifyAlbumId}`} target="_blank">
            <b>{album.title}</b>
          </a>
          {album.year !== null && <> ({album.year})</>}
          <Sep />
          UPC <Mono value={album.upc} />
          <Sep />
          {album.spotifyTrackTotal === null ? (
            <span className="absent">Spotify total not read</span>
          ) : (
            <>{album.spotifyTrackTotal} tracks on Spotify</>
          )}
          <Sep />
          <span className="tag">release {release.state.replace('_', ' ')}</span>{' '}
          {release.mbid && (
            <>
              <a href={`${MB}/release/${release.mbid}`} target="_blank">
                {release.title ?? <span className="absent">not in cache</span>}
              </a>{' '}
              <BarcodeCheck upc={album.upc} barcode={release.barcode} cached={!!release.title} />
              <Sep />
              tracklist{' '}
              {release.tracklist ? (
                <span className={release.tracklist === 'aligned' ? 'ok' : 'bad'}>
                  {release.tracklist.replace('_', ' ')}
                </span>
              ) : (
                <span className="absent">unknown</span>
              )}
            </>
          )}
          {release.state !== 'matched' && release.candidates !== null && (
            <> {release.candidates} releases carry this barcode</>
          )}
          {release.checkedAt !== null && (
            <>
              <Sep />
              looked up {new Date(release.checkedAt).toISOString().slice(0, 10)}
            </>
          )}
        </td>
      </tr>
      {tracks.map((track) => (
        <TrackRow key={track.spotifyTrackId} track={track} />
      ))}
    </tbody>
  );
}

// One line per track: the long text (reasons, gaps, errors) sits in each cell's hover title.
function TrackRow({ track }: { track: MatchDebugTrack }) {
  const { recording, classification, verdict, queue } = track;
  const composers = track.works.map((work) =>
    work.composer ? (work.composer.name ?? 'composer has no name') : 'no composer',
  );
  return (
    <tr>
      <td className="mono">
        {track.disc}-{String(track.number).padStart(2, '0')}
      </td>
      <td className="w-wide" title={`${track.title} · ${clock(track.durationMs)}`}>
        <a href={`https://open.spotify.com/track/${track.spotifyTrackId}`} target="_blank">
          {track.title}
        </a>
      </td>
      <td>
        <Mono value={track.isrc} />
      </td>
      <td className="w-mid" title={recordingTitle(track)}>
        {recording.state === 'linked' && (
          <>
            <span className="tag">{MATCHED_BY[recording.matchedBy] ?? recording.matchedBy}</span>{' '}
            {!recording.read && <span className="tag">name only</span>}{' '}
            {recording.lengthMs !== null && (
              <span className="mono text-[var(--faint)]">
                {delta(recording.lengthMs - track.durationMs)}{' '}
              </span>
            )}
            <a href={`${MB}/recording/${recording.mbid}`} target="_blank">
              {recording.title ?? <span className="absent">not in cache</span>}
            </a>
          </>
        )}
        {recording.state === 'contested' && (
          <>
            <span className="tag bad">contested</span>{' '}
            {recording.candidates.map((mbid) => (
              <a key={mbid} className="mono" href={`${MB}/recording/${mbid}`} target="_blank">
                {mbid.slice(0, 8)}{' '}
              </a>
            ))}
          </>
        )}
        {recording.state === 'none' && <span className="absent">no recording</span>}
      </td>
      <td className="w-wide" title={track.works.map(workTitle).join('\n')}>
        {track.works.length === 0 && <span className="absent">no work</span>}
        {track.works.map((work, index) => (
          <span key={work.relatedWorkMbid}>
            {index > 0 && <span className="text-[var(--faint)]"> + </span>}
            <WorkChain work={work} />
          </span>
        ))}
      </td>
      <td className="w-narrow" title={composers.join(', ')}>
        {track.works.map((work, index) => (
          <span key={work.relatedWorkMbid}>
            {index > 0 && ', '}
            {work.composer ? (
              <a href={`${MB}/artist/${work.composer.mbid}`} target="_blank">
                {work.composer.name ?? <span className="absent">no name</span>}
              </a>
            ) : (
              <span className="absent">no composer</span>
            )}
          </span>
        ))}
      </td>
      <td
        className="w-narrow"
        title={[
          classification?.reason ?? 'no reason stored',
          `MusicBrainz evidence alone: ${track.musicBrainzSaysClassical ? 'classical' : 'not enough'}`,
        ].join('\n')}
      >
        {classification ? (
          <>
            <span className={`tag ${classification.state === 'classical' ? 'ok' : 'bad'}`}>
              {classification.state.replace('_', ' ')}
            </span>{' '}
            <span className="text-[var(--faint)]">{classification.provenance}</span>
          </>
        ) : (
          <span className="absent">not classified</span>
        )}
      </td>
      <td
        className="w-mid"
        title={[
          verdict.state === 'held' ? verdict.detail : null,
          ...track.gaps.map((gap) => `• ${gap.reason}`),
        ]
          .filter(Boolean)
          .join('\n')}
      >
        {track.gaps.length > 0 && (
          <span className="mono text-[var(--faint)]">{track.gaps.length} gaps </span>
        )}
        {verdict.state === 'ready' && (
          <span className="ok">Ready{verdict.viaOwnLink ? ' (our own work link)' : ''}</span>
        )}
        {verdict.state === 'not_classical' && <span>Not classical, left out</span>}
        {verdict.state === 'held' && (
          <span className="bad">
            {verdict.label}
            {verdict.waiting && ' (edit sent, waiting)'}
          </span>
        )}
      </td>
      <td
        className="w-narrow"
        title={
          queue
            ? [
                queue.reason,
                queue.error,
                queue.processedAt !== null
                  ? `processed ${new Date(queue.processedAt).toISOString().slice(0, 10)}`
                  : null,
              ]
                .filter(Boolean)
                .join('\n')
            : undefined
        }
      >
        {queue ? (
          <>
            <span className={`tag ${queue.error ? 'bad' : ''}`}>
              {queue.status.replace('_', ' ')}
            </span>{' '}
            <span className="text-[var(--faint)]">
              ×{queue.attempts}
              {queue.outcome && ` · ${queue.outcome}`}
            </span>
          </>
        ) : (
          <span className="absent">not queued</span>
        )}
      </td>
    </tr>
  );
}

function recordingTitle(track: MatchDebugTrack): string {
  const { recording } = track;
  if (recording.state === 'contested') return recording.reason;
  if (recording.state === 'none') return 'No MusicBrainz recording';
  const length =
    recording.lengthMs === null
      ? 'no length'
      : `${clock(recording.lengthMs)} vs Spotify ${clock(track.durationMs)}`;
  return `${recording.title ?? 'not in cache'} · ${length}`;
}

function workTitle(work: MatchDebugWork): string {
  const chain = work.chain
    .map((node) => `${node.title ?? 'untitled'}${node.type ? ` (${node.type})` : ''}`)
    .join(' › ');
  const linked = work.linkedBy === 'prelude' ? ` [our link, ${work.confidence ?? '?'}]` : '';
  return `${chain || 'work not in cache'}${work.catalogues.length ? ` · ${work.catalogues.join(', ')}` : ''}${linked}`;
}

function WorkChain({ work }: { work: MatchDebugWork }) {
  return (
    <>
      {work.linkedBy === 'prelude' && (
        <span className="tag">ours{work.confidence ? `, ${work.confidence}` : ''}</span>
      )}{' '}
      {work.catalogues.length > 0 && (
        <span className="mono text-[var(--ink-2)]">{work.catalogues.join(', ')} </span>
      )}
      {work.chain.length === 0 ? (
        <a className="absent" href={`${MB}/work/${work.relatedWorkMbid}`} target="_blank">
          work not in cache
        </a>
      ) : (
        work.chain.map((node, index) => (
          <span key={node.mbid}>
            {index > 0 && <span className="text-[var(--faint)]"> › </span>}
            <a
              href={`${MB}/work/${node.mbid}`}
              target="_blank"
              className={node.filed ? 'font-semibold' : undefined}
            >
              {node.title ?? <span className="absent">untitled</span>}
            </a>
          </span>
        ))
      )}
    </>
  );
}

function BarcodeCheck({
  upc,
  barcode,
  cached,
}: {
  upc: string | null;
  barcode: string | null;
  cached: boolean;
}) {
  if (!cached) return null;
  if (!barcode) return <span className="absent">(release has no barcode)</span>;
  const same = upc !== null && upc.replace(/^0+/, '') === barcode.replace(/^0+/, '');
  return same ? (
    <span className="ok">barcode matches</span>
  ) : (
    <span className="bad">
      barcode differs: <span className="mono">{barcode}</span>
    </span>
  );
}

function Mono({ value }: { value: string | null }) {
  return value ? <span className="mono">{value}</span> : <span className="absent">none</span>;
}

function Sep() {
  return <span className="text-[var(--faint)]"> · </span>;
}

function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function delta(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds >= 0 ? '+' : '−'}${Math.abs(seconds).toFixed(1)}s`;
}
