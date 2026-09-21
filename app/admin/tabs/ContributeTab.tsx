'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getBotPayload,
  getBotStatus,
  getContributions,
  recordIsrcSubmission,
  reconcileSubmissions,
  setSubmissionOutcome,
  submitBotBatch,
  type BotStatus,
  type ContributionView,
} from '../actions/contribute';
import { Spinner } from '../components/Spinner';

/**
 * What we can tell MusicBrainz that it does not already know.
 *
 * Each row is a gap with its evidence attached and one link out. Until
 * `prelude_fm_bot` is approved — and permanently for releases, works and
 * merges — the last step is a person clicking that link, so the job of this
 * page is to make the click a confirmation rather than a search.
 */
export function ContributeTab() {
  const [view, setView] = useState<ContributionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [botResult, setBotResult] = useState<string | null>(null);
  const [payload, setPayload] = useState<{ releaseMbid: string; xml: string } | null>(null);

  const refresh = useCallback(() => {
    getContributions()
      .then(setView)
      .catch(() => setView(null));
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    getBotStatus()
      .then(setBot)
      .catch(() => setBot(null));
  }, []);

  async function submitAlbum(releaseMbid: string, albumTitle: string) {
    setBusy(true);
    setBotResult(null);
    try {
      const result = await submitBotBatch(releaseMbid);
      setView(result.view);
      setBot(await getBotStatus());
      setBotResult(
        result.error
          ? `${albumTitle}: not submitted — ${result.error}`
          : `${albumTitle}: submitted ${result.submitted} ISRCs. They stay pending until MusicBrainz shows them.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function revealPayload(releaseMbid: string) {
    if (payload?.releaseMbid === releaseMbid) return setPayload(null);
    setBusy(true);
    try {
      setPayload({ releaseMbid, xml: await getBotPayload(releaseMbid) });
    } finally {
      setBusy(false);
    }
  }

  if (!view) return <Spinner className="h-4 w-4" />;

  async function submitted(releaseMbid: string) {
    setBusy(true);
    try {
      setView(await recordIsrcSubmission(releaseMbid));
    } finally {
      setBusy(false);
    }
  }

  async function reconcile() {
    setBusy(true);
    try {
      const result = await reconcileSubmissions();
      setView(result.view);
    } finally {
      setBusy(false);
    }
  }

  async function outcome(id: number, next: 'applied' | 'rejected' | 'withdrawn') {
    setBusy(true);
    try {
      setView(await setSubmissionOutcome(id, next));
    } finally {
      setBusy(false);
    }
  }

  const pending = view.counts.submissions.pending ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-[70ch] text-[var(--ink-2)]">
        Gaps we can close in MusicBrainz, with the evidence that convinced us. Every link arrives
        filled in; the submission is yours to make. Releases, works and merges stay manual on
        purpose — a wrong one of those is expensive for other people to undo.
      </p>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">prelude_fm_bot</span>
          <span className="mono text-[var(--ink-2)]">
            {bot ? `${bot.spentToday} of ${bot.dailyCap} edits today` : 'not loaded'}
          </span>
        </div>
        <p className="px-4 py-3 text-[var(--ink-2)]">
          {bot?.configured
            ? 'Submits one album at a time, when you press the button on it below, and at no other time — not on a schedule, and never from the worker. Only ISRCs.'
            : 'Not configured. Run `pnpm mb:authorise` to obtain a refresh token for prelude_fm_bot. Everything below still works; the submitting is done by hand.'}
        </p>
        {botResult && <p className="px-4 pb-3">{botResult}</p>}
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">ISRCs</span>
          <span className="mono text-[var(--ink-2)]">
            {view.counts.isrc} on {view.isrcReleases.length} releases
          </span>
        </div>
        {view.isrcReleases.length === 0 && (
          <p className="px-4 py-3 text-[var(--ink-2)]">
            Nothing outstanding. This fills as albums are cached.
          </p>
        )}
        {view.isrcReleases.map((release) => (
          <details key={release.releaseMbid} className="fold">
            <summary>
              <span className="album-title">{release.albumTitle}</span>
              <span className="album-meta">
                {release.missing} missing · barcode {release.barcode ?? '—'} · durations within 3s
              </span>
            </summary>
            <div className="fold-body">
              <table>
                <thead>
                  <tr>
                    <th>Disc/track</th>
                    <th>Our track</th>
                    <th>MusicBrainz recording</th>
                    <th>Δ</th>
                    <th>ISRC</th>
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
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-[var(--faint)]">
                Every row is on this release, whose barcode is the album&apos;s own
                {release.upc && release.upc !== release.barcode ? ` (${release.upc} padded)` : ''}.
                Δ is how far our duration is from MusicBrainz&apos;s.
              </p>
              <div className="toolbar">
                {bot?.configured && (
                  <button
                    className="act"
                    data-variant="primary"
                    disabled={busy}
                    onClick={() => submitAlbum(release.releaseMbid, release.albumTitle)}
                  >
                    Submit {release.missing} as prelude_fm_bot
                  </button>
                )}
                <a className="act" href={release.link} target="_blank" rel="noreferrer">
                  Open in MagicISRC
                </a>
                <button
                  className="act"
                  disabled={busy}
                  onClick={() => submitted(release.releaseMbid)}
                >
                  I submitted these by hand
                </button>
                <button
                  className="act"
                  disabled={busy}
                  onClick={() => revealPayload(release.releaseMbid)}
                >
                  {payload?.releaseMbid === release.releaseMbid ? 'Hide' : 'Show'} the payload
                </button>
                <a
                  className="act"
                  href={`https://musicbrainz.org/release/${release.releaseMbid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Release
                </a>
              </div>
              {payload?.releaseMbid === release.releaseMbid && (
                <pre className="mono overflow-x-auto text-[11px] text-[var(--ink-2)]">
                  {payload.xml}
                </pre>
              )}
            </div>
          </details>
        ))}
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Albums MusicBrainz does not have</span>
          <span className="mono text-[var(--ink-2)]">{view.counts.missingReleases}</span>
        </div>
        <p className="px-4 pt-3 text-[var(--ink-2)]">
          The largest gap left, and the one class that stays manual for good: a duplicate release is
          expensive for other people to merge away. Harmony fills the form from the Spotify album,
          so the work is checking rather than typing. Biggest first, since adding a box set unlocks
          more than adding a single.
        </p>
        {view.missing.map((album) => (
          <div key={album.albumId} className="row">
            <span className="mono w-10 shrink-0 text-[var(--gall)]">{album.tracks}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{album.albumTitle}</span>
              <span className="block text-[11px] text-[var(--ink-2)]">
                {album.year ? `${album.year} · ` : ''}
                {album.reason}
                {album.unanchored < album.tracks &&
                  ` · ${album.tracks - album.unanchored} track(s) already reach a recording elsewhere`}
              </span>
            </span>
            <a className="act shrink-0" href={album.harmony} target="_blank" rel="noreferrer">
              Harmony
            </a>
            <a
              className="act shrink-0"
              href={`https://open.spotify.com/album/${album.albumId}`}
              target="_blank"
              rel="noreferrer"
            >
              Spotify
            </a>
          </div>
        ))}
      </section>

      {view.barcodes.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Releases with no barcode</span>
            <span className="mono text-[var(--ink-2)]">{view.counts.barcodes}</span>
          </div>
          <p className="px-4 pt-3 text-[var(--ink-2)]">
            Found by title and duration rather than by barcode, which is why they have none. Adding
            it makes the release findable the way every other one is.
          </p>
          {view.barcodes.map((gap) => (
            <div key={gap.releaseMbid} className="row">
              <span className="min-w-0 flex-1 truncate">{gap.releaseTitle}</span>
              <span className="mono shrink-0 text-[var(--ink-2)]">{gap.barcode}</span>
              <a className="act shrink-0" href={gap.edit} target="_blank" rel="noreferrer">
                Add it
              </a>
            </div>
          ))}
        </section>
      )}

      {view.misaligned.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Tracklists that do not line up</span>
            <span className="mono text-[var(--ink-2)]">{view.counts.misaligned}</span>
          </div>
          <p className="px-4 pt-3 text-[var(--ink-2)]">
            MusicBrainz has the release, but its tracklist and the album&apos;s disagree, so no
            track can be placed by position. Where the same recordings appear in a different order,
            one of the two is wrong — and it is not always MusicBrainz&apos;s, which is why these
            are reported rather than submitted.
          </p>
          {view.misaligned.map((album) => (
            <details key={album.albumId} className="fold">
              <summary>
                <span className="album-title">{album.albumTitle}</span>
                <span className="album-meta">
                  {album.diagnosis.kind === 'reordered'
                    ? 'same recordings, different order'
                    : album.diagnosis.kind === 'different-length'
                      ? `${album.ourCount} tracks here, ${album.theirCount} on the release`
                      : 'durations do not correspond'}
                  {album.anchoredByIsrc > 0 &&
                    ` · ${album.anchoredByIsrc} anchored by ISRC regardless`}
                </span>
              </summary>
              <div className="fold-body">
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
                          {row.ourTitle ?? <span className="text-[var(--faint)]">nothing</span>}
                          {row.ourMs !== null && (
                            <span className="mono block text-[11px] text-[var(--faint)]">
                              {row.ourMs}ms
                            </span>
                          )}
                        </td>
                        <td>
                          {row.theirTitle ?? <span className="text-[var(--faint)]">nothing</span>}
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
                <div className="toolbar">
                  <a
                    className="act"
                    href={`https://musicbrainz.org/release/${album.releaseMbid}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Release
                  </a>
                  <a
                    className="act"
                    href={`https://open.spotify.com/album/${album.albumId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Spotify
                  </a>
                </div>
              </div>
            </details>
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Recordings with no work</span>
          <span className="mono text-[var(--ink-2)]">{view.counts.workRelationships}</span>
        </div>
        <p className="px-4 pt-3 text-[var(--ink-2)]">
          MusicBrainz holds the recording but has never said what it is a performance of. This is
          the gap that stops a track reaching a work even when everything else lines up.
        </p>
        {view.workGaps.map((gap) => (
          <div key={gap.recordingMbid} className="row">
            <div>
              <div>{gap.recordingTitle}</div>
              <div className="album-meta">{gap.albumTitle}</div>
            </div>
            <a
              className="act ml-auto"
              href={`https://musicbrainz.org/recording/${gap.recordingMbid}`}
              target="_blank"
              rel="noreferrer"
            >
              Recording
            </a>
          </div>
        ))}
      </section>

      {view.contested.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">One ISRC, several recordings</span>
            <span className="mono text-[var(--ink-2)]">{view.contested.length}</span>
          </div>
          <p className="px-4 pt-3 text-[var(--ink-2)]">
            An upstream error rather than a gap: an ISRC identifies one recording, so two holding it
            means one of them is wrong. These cost us real links, and they are fixable.
          </p>
          {view.contested.map((row) => (
            <div key={row.isrc} className="row">
              <span className="mono">{row.isrc}</span>
              <span className="ml-3 text-[var(--ink-2)]">{row.titles}</span>
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Submitted</span>
          <span className="mono text-[var(--ink-2)]">{pending} awaiting an outcome</span>
        </div>
        <div className="toolbar">
          <button className="act" disabled={busy} onClick={reconcile}>
            Check what landed
          </button>
          <span className="text-[var(--ink-2)]">
            A submitted edit is a proposal; editors vote. Nothing is marked applied until
            MusicBrainz shows it.
          </span>
        </div>
        {view.recent.length === 0 && (
          <p className="px-4 py-3 text-[var(--ink-2)]">Nothing submitted yet.</p>
        )}
        {view.recent.map((row) => (
          <div key={row.id} className="row">
            <span className="tag">{row.kind}</span>
            <span className="mono ml-2">{row.value}</span>
            <span className="ml-3 text-[var(--ink-2)]">
              {row.submittedBy} · {new Date(row.submittedAt).toLocaleDateString()} · {row.outcome}
            </span>
            {row.outcome === 'pending' && (
              <span className="ml-auto flex gap-2">
                <button className="act" disabled={busy} onClick={() => outcome(row.id, 'applied')}>
                  Applied
                </button>
                <button className="act" disabled={busy} onClick={() => outcome(row.id, 'rejected')}>
                  Rejected
                </button>
              </span>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
