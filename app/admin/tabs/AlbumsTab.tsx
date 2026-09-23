'use client';

import { useEffect, useState } from 'react';
import {
  getAlbumTracks,
  getAlbums,
  getCoverage,
  getIsrcSubmissionLinks,
  recheckAlbum,
} from '../actions/coverage';
import {
  COVERAGE_LISTENER_NOTE,
  STATE_LABEL,
  WHAT_IT_NEEDS,
  type AlbumRow,
  type AlbumState,
  type AlbumTrackRow,
  type Coverage,
} from '../lib/album-state';
import { inboxFocusForAlbum, type InboxFocus } from '../lib/inbox-focus';
import { Spinner } from '../components/Spinner';
import { adminFailureMessage, LoadFailure } from '../components/AdminFailure';
import { useAdminAction } from '../components/useAdminAction';

/**
 * The one thing to do about this album, and where to do it in the Inbox.
 *
 * Harmony and MagicISRC only run through the Inbox ledger — never as naked
 * links that skip mb_submission.
 */
function nextStep(
  album: AlbumRow,
  submission?: { missing: number },
): { label: string; hint: string; focus: InboxFocus | null } | null {
  switch (album.state) {
    case 'anchored':
    case 'unchecked':
      return null;

    case 'partial':
    case 'needs_isrcs':
      return album.mbReleaseId
        ? submission
          ? {
              label:
                submission.missing > 0
                  ? `Submit ${submission.missing} ISRC${submission.missing === 1 ? '' : 's'} in Inbox`
                  : 'No verified ISRC action',
              hint:
                submission.missing > 0
                  ? 'Open the matching ISRC row in Inbox. MagicISRC and the bot only receive ledger-eligible rows.'
                  : 'The gap stays visible until eligibility checks pass.',
              focus: inboxFocusForAlbum(album),
            }
          : {
              label: 'No verified ISRC action',
              hint: 'The gap stays visible, but no submission is offered until eligibility checks pass.',
              focus: inboxFocusForAlbum(album),
            }
        : {
            label: 'Add release in Inbox',
            hint: 'Some recordings may already be in MusicBrainz under another release; this pressing still needs adding through Harmony with ledger confirmation.',
            focus: inboxFocusForAlbum(album),
          };

    case 'absent':
      return {
        label: 'Add release in Inbox',
        hint: 'Harmony fills the form from the Spotify album. Confirm in Inbox after submitting so mb_submission records it.',
        focus: inboxFocusForAlbum(album),
      };

    case 'ambiguous':
      return {
        label: 'Pick release in Inbox',
        hint: 'Several releases share this barcode. Inbox shows the cached candidates and the existing read-only barcode lookup.',
        focus: inboxFocusForAlbum(album),
      };
  }
}

export function AlbumsTab({
  state,
  onStateChange,
  onOpenInbox,
}: {
  state?: AlbumState;
  onStateChange: (state?: AlbumState) => void;
  onOpenInbox: (focus: InboxFocus) => void;
}) {
  const { run } = useAdminAction();
  const [search, setSearch] = useState('');
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [albums, setAlbums] = useState<AlbumRow[] | null>(null);
  const [albumsError, setAlbumsError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Record<string, AlbumTrackRow[]>>({});
  const [trackErrors, setTrackErrors] = useState<Record<string, string>>({});
  const [submissionLinks, setSubmissionLinks] = useState<
    Record<string, { href: string; missing: number }>
  >({});
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [recheckResult, setRecheckResult] = useState<Record<string, string>>({});

  useEffect(() => {
    void getCoverage()
      .then(setCoverage)
      .catch((error: unknown) => setCoverageError(adminFailureMessage(error)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getAlbums(state, search)
      .then(async (rows) => {
        if (cancelled) return;
        setAlbums(rows);
        setAlbumsError(null);
        const needSeeds = rows
          .filter(
            (row) => row.mbReleaseId && (row.state === 'partial' || row.state === 'needs_isrcs'),
          )
          .map((row) => row.id);
        if (needSeeds.length === 0) {
          setSubmissionLinks({});
          return;
        }
        const fetched = await getIsrcSubmissionLinks(needSeeds);
        if (!cancelled) setSubmissionLinks(fetched);
      })
      .catch((error: unknown) => {
        if (!cancelled) setAlbumsError(adminFailureMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [state, search]);

  async function recheck(albumId: string) {
    setRechecking(albumId);
    await run('Rechecking album…', async () => {
      const result = await recheckAlbum(albumId);
      setRecheckResult((current) => ({
        ...current,
        [albumId]:
          result.resolved > 0
            ? `matched ${result.resolved} more — ${result.anchored}/${result.tracks} anchored`
            : `no change — ${result.anchored}/${result.tracks} anchored`,
      }));
      const [rows, nextCoverage] = await Promise.all([getAlbums(state, search), getCoverage()]);
      setAlbums(rows);
      setCoverage(nextCoverage);
    });
    setRechecking(null);
  }

  async function toggle(albumId: string) {
    if (open === albumId) {
      setOpen(null);
      return;
    }
    setOpen(albumId);
    if (!tracks[albumId]) {
      setTrackErrors((current) => {
        const next = { ...current };
        delete next[albumId];
        return next;
      });
      try {
        const rows = await getAlbumTracks(albumId);
        setTracks((current) => ({ ...current, [albumId]: rows }));
      } catch (error) {
        setTrackErrors((current) => ({ ...current, [albumId]: adminFailureMessage(error) }));
      }
    }
  }

  const states: AlbumState[] = [
    'absent',
    'needs_isrcs',
    'partial',
    'ambiguous',
    'anchored',
    'unchecked',
  ];

  const share =
    coverage && coverage.tracks
      ? Math.round((coverage.anchoredTracks / coverage.tracks) * 100)
      : null;

  return (
    <div className="flex flex-col gap-5 pb-16">
      {coverageError !== null && <LoadFailure what="album coverage" error={coverageError} />}
      {coverage && (
        <section className="panel px-4 py-4">
          <p className="eyebrow mb-2">Album pipeline</p>
          <p className="mono text-[26px] leading-none">
            {share}%
            <span className="ml-3 text-[13px] text-[var(--faint)]">
              {coverage.anchoredTracks.toLocaleString()} of {coverage.tracks.toLocaleString()}{' '}
              tracks anchored
            </span>
          </p>
          <div className="mt-3 flex h-1.5 w-full overflow-hidden bg-[var(--slip-2)]">
            <div className="bg-[var(--viridian)]" style={{ width: `${share ?? 0}%` }} />
          </div>
          <p className="mt-3 max-w-[70ch] text-[var(--ink-2)]">{COVERAGE_LISTENER_NOTE}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 border-t border-[var(--rule)] pt-3 sm:grid-cols-3">
            <div>
              <dt className="text-[11px] text-[var(--ink-2)]">Durably classified</dt>
              <dd className="mono text-[15px]">
                {coverage.classifiedTracks.toLocaleString()}
                <span className="text-[11px] text-[var(--faint)]">
                  {' '}
                  / {coverage.tracks.toLocaleString()}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-[var(--ink-2)]">Classical</dt>
              <dd className="mono text-[15px]">{coverage.classicalTracks.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-[var(--ink-2)]">
                Tracks with a cached MB work relation
              </dt>
              <dd className="mono text-[15px]">
                {coverage.tracksReachingWork.toLocaleString()}
                <span className="text-[11px] text-[var(--faint)]">
                  {' '}
                  / {coverage.tracks.toLocaleString()}
                </span>
              </dd>
            </div>
          </dl>
          <div className="mt-4 border-t border-[var(--rule)] pt-3">
            <p className="eyebrow mb-2">By state</p>
            <div className="slip">
              {coverage.byState.map((row) => (
                <button
                  key={row.state}
                  className="row w-full text-left"
                  onClick={() => onStateChange(row.state)}
                >
                  <span
                    className={`mono w-12 shrink-0 text-[15px] ${
                      row.state === 'anchored' ? 'text-[var(--viridian)]' : 'text-[var(--gall)]'
                    }`}
                  >
                    {row.albums}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block">{STATE_LABEL[row.state]}</span>
                    <span className="block text-[11px] text-[var(--ink-2)]">
                      {WHAT_IT_NEEDS[row.state]}
                    </span>
                  </span>
                  <span className="mono shrink-0 text-[11px] text-[var(--faint)]">
                    {row.tracks.toLocaleString()} tracks
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <div className="panel">
        <div className="toolbar">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find an album"
            className="min-w-[220px] flex-1"
          />
          <button className="act" onClick={() => onStateChange(undefined)} disabled={!state}>
            All
          </button>
          {states.map((item) => (
            <button
              key={item}
              className="act"
              onClick={() => onStateChange(item)}
              disabled={state === item}
            >
              {STATE_LABEL[item]}
            </button>
          ))}
        </div>
      </div>

      {albumsError !== null && <LoadFailure what="albums" error={albumsError} />}
      {!albums ? (
        albumsError === null && (
          <div className="flex items-center gap-2 py-10 text-[var(--faint)]">
            <Spinner className="h-3 w-3" />
            <span className="text-xs">Loading…</span>
          </div>
        )
      ) : albums.length === 0 ? (
        <div className="slip px-4 py-5 text-[var(--ink-2)]">No albums here.</div>
      ) : (
        <div className="slip">
          {albums.map((album) => {
            const step = nextStep(album, submissionLinks[album.id]);
            const isOpen = open === album.id;
            return (
              <div key={album.id} className="rule-b last:border-b-0">
                <div className="album-row">
                  <button className="album-open" onClick={() => toggle(album.id)}>
                    <span className="album-title">{album.title}</span>
                    <span className="album-meta">
                      <span
                        className={`mono ${
                          album.state === 'anchored'
                            ? 'text-[var(--viridian)]'
                            : 'text-[var(--gall)]'
                        }`}
                      >
                        {album.anchored}/{album.tracks}
                      </span>
                      <span className="text-[var(--faint)]">anchored</span>
                      <span className="mono">
                        {album.classified}/{album.tracks}
                      </span>
                      <span className="text-[var(--faint)]">classified</span>
                      <span className="mono">
                        {album.tracksReachingWork}/{album.tracks}
                      </span>
                      <span className="text-[var(--faint)]">have a cached work relation</span>
                      <span className="tag">{STATE_LABEL[album.state]}</span>
                    </span>
                  </button>
                  {recheckResult[album.id] && (
                    <span className="shrink-0 text-[11px] text-[var(--viridian)]">
                      {recheckResult[album.id]}
                    </span>
                  )}
                  {album.state !== 'anchored' && (
                    <button
                      className="act shrink-0"
                      disabled={rechecking === album.id}
                      onClick={() => recheck(album.id)}
                      title="Ask MusicBrainz about this album's ISRCs again. Use it after submitting."
                    >
                      {rechecking === album.id ? 'Checking…' : 'Re-check'}
                    </button>
                  )}
                  {step && (
                    <>
                      {step.focus ? (
                        <button
                          className="act shrink-0"
                          data-variant="primary"
                          title={step.hint}
                          onClick={() => onOpenInbox(step.focus!)}
                        >
                          Open in Inbox
                        </button>
                      ) : (
                        <span className="tag shrink-0" title={step.hint}>
                          {step.label}
                        </span>
                      )}
                      {step.focus && (
                        <span className="mono shrink-0 text-[11px] text-[var(--faint)]">
                          {step.label}
                        </span>
                      )}
                    </>
                  )}
                </div>

                {isOpen && (
                  <div className="px-4 pb-3">
                    {trackErrors[album.id] !== undefined ? (
                      <LoadFailure what="this album's tracks" error={trackErrors[album.id]} />
                    ) : !tracks[album.id] ? (
                      <Spinner className="h-3 w-3" />
                    ) : (
                      <table>
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Track</th>
                            <th>ISRC</th>
                            <th>MB recording</th>
                            <th>Classification</th>
                            <th>MB work relationship</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tracks[album.id].map((track) => (
                            <tr key={track.id}>
                              <td className="mono text-[var(--faint)]">
                                {track.discNumber}.{track.trackNumber}
                              </td>
                              <td>{track.title}</td>
                              <td className="mono text-[11px] text-[var(--ink-2)]">
                                {track.isrc ?? <span className="absent">none</span>}
                              </td>
                              <td>
                                {track.recordingMbid ? (
                                  <a
                                    className="mono text-[11px] text-[var(--viridian)]"
                                    href={`https://musicbrainz.org/recording/${track.recordingMbid}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {track.recordingTitle ?? 'cache missing'}
                                  </a>
                                ) : (
                                  <span className="absent">not matched</span>
                                )}
                              </td>
                              <td className="text-[var(--ink-2)]">
                                {track.classification ? (
                                  <span title={track.classification.reason ?? undefined}>
                                    {track.classification.state.replace('_', ' ')}
                                    <span className="block text-[11px] text-[var(--faint)]">
                                      {track.classification.provenance.replace('_', ' ')}
                                    </span>
                                  </span>
                                ) : (
                                  <span className="absent">missing</span>
                                )}
                              </td>
                              <td className="text-[var(--ink-2)]">
                                {track.works.length === 0 ? (
                                  <span className="absent">
                                    {!track.recordingMbid
                                      ? 'missing — not anchored'
                                      : track.recordingDetail === null
                                        ? 'missing — recording cache'
                                        : track.recordingDetail === 'stub'
                                          ? 'missing — recording not fully read'
                                          : 'none in MusicBrainz'}
                                  </span>
                                ) : (
                                  track.works.map((work) => (
                                    <span key={work.mbid} className="block">
                                      <a
                                        className="text-[var(--viridian)]"
                                        href={`https://musicbrainz.org/work/${work.mbid}`}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        {work.title ?? 'cache missing'}
                                      </a>
                                      {work.parentTitle && (
                                        <span className="block text-[11px] text-[var(--faint)]">
                                          part of {work.parentTitle}
                                        </span>
                                      )}
                                    </span>
                                  ))
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
