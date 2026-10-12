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
  release_position: 'release position',
  reordered_title_duration: 'title + length',
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
        <td colSpan={8}>
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

function TrackRow({ track }: { track: MatchDebugTrack }) {
  const { recording, classification, verdict, queue } = track;
  return (
    <tr>
      <td className="mono whitespace-nowrap">
        {track.disc}-{String(track.number).padStart(2, '0')}
      </td>
      <td className="min-w-[180px]">
        <a href={`https://open.spotify.com/track/${track.spotifyTrackId}`} target="_blank">
          {track.title}
        </a>
        <div className="text-[var(--faint)]">
          <Mono value={track.isrc} /> · <span className="mono">{clock(track.durationMs)}</span>
        </div>
      </td>
      <td className="min-w-[160px]">
        {recording.state === 'linked' && (
          <>
            <span className="tag">{MATCHED_BY[recording.matchedBy] ?? recording.matchedBy}</span>{' '}
            {!recording.read && <span className="tag">name only</span>}{' '}
            <a href={`${MB}/recording/${recording.mbid}`} target="_blank">
              {recording.title ?? <span className="absent">not in cache</span>}
            </a>
            <div className="mono text-[var(--faint)]">
              {recording.lengthMs === null ? (
                <span className="absent">no length</span>
              ) : (
                <>
                  {clock(recording.lengthMs)} ({delta(recording.lengthMs - track.durationMs)})
                </>
              )}
            </div>
          </>
        )}
        {recording.state === 'contested' && (
          <>
            <span className="tag bad">contested</span> {recording.reason}
            {recording.candidates.map((mbid) => (
              <div key={mbid}>
                <a className="mono" href={`${MB}/recording/${mbid}`} target="_blank">
                  {mbid.slice(0, 8)}
                </a>
              </div>
            ))}
          </>
        )}
        {recording.state === 'none' && <span className="absent">no recording</span>}
      </td>
      <td className="min-w-[220px]">
        {track.works.length === 0 && <span className="absent">no work</span>}
        {track.works.map((work) => (
          <WorkCell key={work.relatedWorkMbid} work={work} />
        ))}
      </td>
      <td>
        {track.works.map((work) =>
          work.composer ? (
            <div key={work.relatedWorkMbid}>
              <a href={`${MB}/artist/${work.composer.mbid}`} target="_blank">
                {work.composer.name ?? <span className="absent">no name</span>}
              </a>
            </div>
          ) : (
            <div key={work.relatedWorkMbid} className="absent">
              no composer
            </div>
          ),
        )}
      </td>
      <td className="min-w-[160px]">
        {classification ? (
          <>
            <span className={`tag ${classification.state === 'classical' ? 'ok' : 'bad'}`}>
              {classification.state.replace('_', ' ')}
            </span>{' '}
            <span className="text-[var(--faint)]">{classification.provenance}</span>
            <div className="text-[var(--ink-2)]">
              {classification.reason ?? <span className="absent">no reason stored</span>}
            </div>
          </>
        ) : (
          <span className="absent">not classified</span>
        )}
        <div className="text-[var(--faint)]">
          MusicBrainz evidence alone: {track.musicBrainzSaysClassical ? 'classical' : 'not enough'}
        </div>
      </td>
      <td className="min-w-[180px]">
        {verdict.state === 'ready' && (
          <span className="ok">Ready{verdict.viaOwnLink ? ' (our own work link)' : ''}</span>
        )}
        {verdict.state === 'not_classical' && <span>Not classical, left out</span>}
        {verdict.state === 'held' && (
          <span className="bad" title={verdict.detail}>
            {verdict.label}
            {verdict.waiting && ' (edit sent, waiting)'}
          </span>
        )}
        {track.gaps.map((gap) => (
          <div key={gap.code} className="text-[var(--faint)]" title={gap.code}>
            {gap.reason}
          </div>
        ))}
      </td>
      <td className="min-w-[120px]">
        {queue ? (
          <>
            <span className="tag">{queue.status.replace('_', ' ')}</span>{' '}
            <span className="text-[var(--faint)]">
              {queue.attempts} {queue.attempts === 1 ? 'try' : 'tries'}
            </span>
            {queue.outcome && <div>MB pass: {queue.outcome}</div>}
            {queue.reason && <div className="text-[var(--ink-2)]">{queue.reason}</div>}
            {queue.error && <div className="bad">{queue.error}</div>}
            {queue.processedAt !== null && (
              <div className="text-[var(--faint)]">
                {new Date(queue.processedAt).toISOString().slice(0, 10)}
              </div>
            )}
          </>
        ) : (
          <span className="absent">not queued</span>
        )}
      </td>
    </tr>
  );
}

function WorkCell({ work }: { work: MatchDebugWork }) {
  return (
    <div>
      {work.linkedBy === 'prelude' && (
        <span className="tag">ours{work.confidence ? `, ${work.confidence}` : ''}</span>
      )}{' '}
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
              title={node.filed ? 'The player files the track under this work' : undefined}
            >
              {node.title ?? <span className="absent">untitled</span>}
            </a>
            {node.type && <span className="text-[var(--faint)]"> ({node.type})</span>}
          </span>
        ))
      )}
      {work.catalogues.length > 0 && (
        <span className="mono text-[var(--ink-2)]"> {work.catalogues.join(', ')}</span>
      )}
    </div>
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
