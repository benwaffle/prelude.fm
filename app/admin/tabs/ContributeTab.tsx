'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getBotPayload,
  getBotStatus,
  getContributions,
  recordBarcodeSubmission,
  recordContestedIsrcReport,
  recordIsrcSubmission,
  recordMisalignedTracklistReport,
  recordReleaseSubmission,
  recordStreamingUrlSubmission,
  recordWorkCreationSubmission,
  recordWorkRelationshipSubmission,
  recheckBarcode,
  recheckCreatedWork,
  recheckErrorReport,
  recheckIsrcRelease,
  recheckReleaseSubmission,
  recheckStreamingUrl,
  recheckWorkRelationship,
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
  const [workCreateForms, setWorkCreateForms] = useState<
    Record<string, { workMbid: string; editId: string }>
  >({});
  const [releaseForms, setReleaseForms] = useState<
    Record<string, { releaseMbid: string; editId: string }>
  >({});
  const [streamingUrlForms, setStreamingUrlForms] = useState<Record<string, { editId: string }>>(
    {},
  );
  const [barcodeForms, setBarcodeForms] = useState<Record<string, { editId: string }>>({});
  const [isrcForms, setIsrcForms] = useState<Record<string, { editId: string }>>({});
  const [workRelationshipForms, setWorkRelationshipForms] = useState<
    Record<string, { editId: string }>
  >({});
  const [errorForms, setErrorForms] = useState<Record<string, { editId: string }>>({});

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
    const form = isrcForms[releaseMbid] ?? { editId: '' };
    setBusy(true);
    try {
      setView(await recordIsrcSubmission(releaseMbid, { editId: form.editId }));
    } finally {
      setBusy(false);
    }
  }

  async function recheckIsrcs(releaseMbid: string) {
    setBusy(true);
    try {
      const result = await recheckIsrcRelease(releaseMbid);
      setView(result.view);
    } finally {
      setBusy(false);
    }
  }

  async function submittedBarcode(releaseMbid: string) {
    const form = barcodeForms[releaseMbid] ?? { editId: '' };
    setBusy(true);
    try {
      setView(await recordBarcodeSubmission(releaseMbid, { editId: form.editId }));
    } finally {
      setBusy(false);
    }
  }

  async function recheckBarcodeRow(releaseMbid: string) {
    setBusy(true);
    try {
      const result = await recheckBarcode(releaseMbid);
      setView(result.view);
    } finally {
      setBusy(false);
    }
  }

  async function submittedStreamingUrl(releaseMbid: string, albumId: string) {
    const form = streamingUrlForms[albumId] ?? { editId: '' };
    setBusy(true);
    try {
      setView(
        await recordStreamingUrlSubmission(releaseMbid, albumId, {
          editId: form.editId,
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function recheckStreaming(releaseMbid: string) {
    setBusy(true);
    try {
      const result = await recheckStreamingUrl(releaseMbid);
      setView(result.view);
    } finally {
      setBusy(false);
    }
  }

  async function submittedRelease(albumId: string) {
    const form = releaseForms[albumId] ?? { releaseMbid: '', editId: '' };
    setBusy(true);
    try {
      setView(
        await recordReleaseSubmission(albumId, {
          releaseMbid: form.releaseMbid,
          editId: form.editId,
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function recheckRelease(albumId: string) {
    setBusy(true);
    try {
      const result = await recheckReleaseSubmission(albumId);
      setView(result.view);
    } finally {
      setBusy(false);
    }
  }

  async function submittedContestedIsrc(isrc: string, disposition: 'reported' | 'fixed') {
    const form = errorForms[isrc] ?? { editId: '' };
    setBusy(true);
    try {
      setView(await recordContestedIsrcReport(isrc, disposition, { editId: form.editId }));
    } finally {
      setBusy(false);
    }
  }

  async function submittedMisaligned(albumId: string, disposition: 'reported' | 'fixed') {
    const form = errorForms[albumId] ?? { editId: '' };
    setBusy(true);
    try {
      setView(await recordMisalignedTracklistReport(albumId, disposition, { editId: form.editId }));
    } finally {
      setBusy(false);
    }
  }

  async function recheckError(kind: 'contested_isrc' | 'misaligned_tracklist', key: string) {
    setBusy(true);
    try {
      const result = await recheckErrorReport(kind, key);
      setView(result.view);
    } finally {
      setBusy(false);
    }
  }

  async function submittedWorkRelationship(recordingMbid: string, workMbid: string) {
    const form = workRelationshipForms[`${recordingMbid}:${workMbid}`] ?? { editId: '' };
    setBusy(true);
    try {
      setView(
        await recordWorkRelationshipSubmission(recordingMbid, workMbid, { editId: form.editId }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function recheckRelationship(recordingMbid: string, workMbid: string) {
    setBusy(true);
    try {
      const result = await recheckWorkRelationship(recordingMbid, workMbid);
      setView(result.view);
    } finally {
      setBusy(false);
    }
  }

  async function submittedWorkCreation(recordingMbid: string) {
    const form = workCreateForms[recordingMbid] ?? { workMbid: '', editId: '' };
    setBusy(true);
    try {
      setView(
        await recordWorkCreationSubmission(recordingMbid, form.workMbid, {
          editId: form.editId,
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function recheckWork(workMbid: string) {
    setBusy(true);
    try {
      const result = await recheckCreatedWork(workMbid);
      setView(result.view);
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
                {release.missing} missing
                {release.eligible < release.missing
                  ? ` · ${release.eligible} still to submit`
                  : ''}{' '}
                · barcode {release.barcode ?? '—'} · durations within 3s
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
                Every row is on this release, whose barcode is the album&apos;s own
                {release.upc && release.upc !== release.barcode ? ` (${release.upc} padded)` : ''}.
                Δ is how far our duration is from MusicBrainz&apos;s. Confirmed ISRCs stay listed
                until the cache holds them. MagicISRC and the bot only receive rows not yet in the
                ledger.
              </p>
              <div className="toolbar">
                {bot?.configured && release.eligible > 0 && (
                  <button
                    className="act"
                    data-variant="primary"
                    disabled={busy}
                    onClick={() => submitAlbum(release.releaseMbid, release.albumTitle)}
                  >
                    Submit {release.eligible} as prelude_fm_bot
                  </button>
                )}
                {release.eligible > 0 && (
                  <>
                    <a className="act" href={release.link} target="_blank" rel="noreferrer">
                      Open in MagicISRC
                    </a>
                    <input
                      className="mono w-32 shrink-0"
                      placeholder="edit ID (optional)"
                      value={(isrcForms[release.releaseMbid] ?? { editId: '' }).editId}
                      onChange={(event) =>
                        setIsrcForms((current) => ({
                          ...current,
                          [release.releaseMbid]: { editId: event.target.value },
                        }))
                      }
                    />
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
                  </>
                )}
                {release.tracks.some((track) => track.ledger) && (
                  <button
                    className="act"
                    disabled={busy}
                    onClick={() => recheckIsrcs(release.releaseMbid)}
                  >
                    Recheck
                  </button>
                )}
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
          more than adding a single. Opening Harmony or Spotify does not write the ledger. A
          resulting release MBID is optional — Harmony often queues the edit before one exists — and
          an edit ID stays missing if you do not have it.
        </p>
        {view.missing.map((album) => {
          const form = releaseForms[album.albumId] ?? { releaseMbid: '', editId: '' };
          return (
            <div key={album.albumId} className="row">
              <span className="mono w-10 shrink-0 text-[var(--gall)]">{album.tracks}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{album.albumTitle}</span>
                <span className="block text-[11px] text-[var(--ink-2)]">
                  {album.year ? `${album.year} · ` : ''}
                  {album.reason}
                  {album.unanchored < album.tracks &&
                    ` · ${album.tracks - album.unanchored} track(s) already reach a recording elsewhere`}
                  {album.ledger?.releaseMbid && ` · ${album.ledger.releaseMbid}`}
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
              {album.ledger ? (
                <>
                  <span className="album-meta shrink-0">{album.ledger.label}</span>
                  <button
                    className="act shrink-0"
                    disabled={busy}
                    onClick={() => recheckRelease(album.albumId)}
                  >
                    Recheck
                  </button>
                </>
              ) : (
                <>
                  <input
                    className="mono w-40 shrink-0"
                    placeholder="release MBID (optional)"
                    value={form.releaseMbid}
                    onChange={(event) =>
                      setReleaseForms((current) => ({
                        ...current,
                        [album.albumId]: { ...form, releaseMbid: event.target.value },
                      }))
                    }
                  />
                  <input
                    className="mono w-32 shrink-0"
                    placeholder="edit ID (optional)"
                    value={form.editId}
                    onChange={(event) =>
                      setReleaseForms((current) => ({
                        ...current,
                        [album.albumId]: { ...form, editId: event.target.value },
                      }))
                    }
                  />
                  <button
                    className="act shrink-0"
                    data-variant="primary"
                    disabled={busy}
                    onClick={() => submittedRelease(album.albumId)}
                  >
                    I submitted it
                  </button>
                </>
              )}
            </div>
          );
        })}
      </section>

      {view.barcodes.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Releases with no barcode</span>
            <span className="mono text-[var(--ink-2)]">{view.counts.barcodes}</span>
          </div>
          <p className="px-4 pt-3 text-[var(--ink-2)]">
            Found by title and duration rather than by barcode, which is why they have none. Adding
            it makes the release findable the way every other one is. Copy the exact Spotify value,
            add it on the release edit page, then confirm here only after submitting the edit.
            Opening the edit page does not write the ledger. A confirmed barcode stays listed until
            the cache holds one.
          </p>
          {view.barcodes.map((gap) => {
            const form = barcodeForms[gap.releaseMbid] ?? { editId: '' };
            return (
              <div key={gap.releaseMbid} className="row">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{gap.releaseTitle}</span>
                  <span className="album-meta">
                    title matched · {gap.trackCount} tracks · worst duration difference{' '}
                    {gap.maxDurationDeltaMs}ms
                  </span>
                </span>
                <code className="mono shrink-0 select-all text-[var(--ink-2)]">{gap.barcode}</code>
                <button
                  className="act shrink-0"
                  disabled={busy}
                  onClick={() => navigator.clipboard.writeText(gap.barcode)}
                >
                  Copy barcode
                </button>
                <a className="act shrink-0" href={gap.edit} target="_blank" rel="noreferrer">
                  Edit release
                </a>
                {gap.ledger ? (
                  <>
                    <span className="album-meta shrink-0">{gap.ledger.label}</span>
                    <button
                      className="act shrink-0"
                      disabled={busy}
                      onClick={() => recheckBarcodeRow(gap.releaseMbid)}
                    >
                      Recheck
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      className="mono w-32 shrink-0"
                      placeholder="edit ID (optional)"
                      value={form.editId}
                      onChange={(event) =>
                        setBarcodeForms((current) => ({
                          ...current,
                          [gap.releaseMbid]: { editId: event.target.value },
                        }))
                      }
                    />
                    <button
                      className="act shrink-0"
                      data-variant="primary"
                      disabled={busy}
                      onClick={() => submittedBarcode(gap.releaseMbid)}
                    >
                      I submitted it
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </section>
      )}

      {view.streamingUrls.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Releases with no Spotify streaming URL</span>
            <span className="mono text-[var(--ink-2)]">{view.counts.streamingUrls}</span>
          </div>
          <p className="px-4 pt-3 text-[var(--ink-2)]">
            Only releases whose URL relations we have already fetched. Unfetched stays unknown, not
            missing, and is not listed. Copy the Spotify album URL, add it as a free streaming link
            on the release edit page&apos;s External Links section — not the relationship editor —
            then confirm here only after submitting the edit. Opening the edit page does not write
            the ledger.
          </p>
          {view.streamingUrls.map((gap) => {
            const form = streamingUrlForms[gap.albumId] ?? { editId: '' };
            return (
              <div key={`${gap.releaseMbid}:${gap.albumId}`} className="row">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{gap.releaseTitle}</span>
                  <span className="album-meta">{gap.albumTitle}</span>
                </span>
                <code className="mono max-w-[28ch] shrink-0 truncate select-all text-[var(--ink-2)]">
                  {gap.spotifyUrl}
                </code>
                <button
                  className="act shrink-0"
                  disabled={busy}
                  onClick={() => navigator.clipboard.writeText(gap.spotifyUrl)}
                >
                  Copy URL
                </button>
                <a className="act shrink-0" href={gap.edit} target="_blank" rel="noreferrer">
                  Edit release
                </a>
                {gap.ledger ? (
                  <>
                    <span className="album-meta shrink-0">{gap.ledger.label}</span>
                    <button
                      className="act shrink-0"
                      disabled={busy}
                      onClick={() => recheckStreaming(gap.releaseMbid)}
                    >
                      Recheck
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      className="mono w-32 shrink-0"
                      placeholder="edit ID (optional)"
                      value={form.editId}
                      onChange={(event) =>
                        setStreamingUrlForms((current) => ({
                          ...current,
                          [gap.albumId]: { editId: event.target.value },
                        }))
                      }
                    />
                    <button
                      className="act shrink-0"
                      data-variant="primary"
                      disabled={busy}
                      onClick={() => submittedStreamingUrl(gap.releaseMbid, gap.albumId)}
                    >
                      I submitted it
                    </button>
                  </>
                )}
              </div>
            );
          })}
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
            are reported rather than submitted. Both sides stay visible. Opening a link does not
            write the ledger, and nothing here changes the cached MusicBrainz tracklist.
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
                  {album.ledger && ` · ${album.ledger.disposition ?? album.ledger.label}`}
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
                    href={`https://musicbrainz.org/release/${album.releaseMbid}/edit`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Edit release
                  </a>
                  <a
                    className="act"
                    href={`https://open.spotify.com/album/${album.albumId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Spotify
                  </a>
                  {album.ledger ? (
                    <>
                      <span className="album-meta">
                        {album.ledger.disposition} · {album.ledger.label}
                      </span>
                      <button
                        className="act"
                        disabled={busy}
                        onClick={() => recheckError('misaligned_tracklist', album.albumId)}
                      >
                        Recheck
                      </button>
                    </>
                  ) : (
                    <>
                      <input
                        className="mono w-32"
                        placeholder="edit ID (optional)"
                        value={(errorForms[album.albumId] ?? { editId: '' }).editId}
                        onChange={(event) =>
                          setErrorForms((current) => ({
                            ...current,
                            [album.albumId]: { editId: event.target.value },
                          }))
                        }
                      />
                      <button
                        className="act"
                        data-variant="primary"
                        disabled={busy}
                        onClick={() => submittedMisaligned(album.albumId, 'reported')}
                      >
                        I reported it
                      </button>
                      <button
                        className="act"
                        disabled={busy}
                        onClick={() => submittedMisaligned(album.albumId, 'fixed')}
                      >
                        I fixed it
                      </button>
                    </>
                  )}
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
        {view.workGaps.map((gap) => {
          const created = gap.ledger.find((row) => row.kind === 'work');
          const form = workCreateForms[gap.recordingMbid] ?? { workMbid: '', editId: '' };
          return (
            <details key={gap.recordingMbid} className="fold">
              <summary>
                <span className="album-title">{gap.recordingTitle}</span>
                <span className="album-meta">
                  {gap.albumTitle} · {gap.candidates.length} MB candidate
                  {gap.candidates.length === 1 ? '' : 's'}
                  {gap.ledger.length > 0 &&
                    ` · ${gap.ledger.length} recorded${gap.ledger.some((row) => !row.editId) ? ', edit ID missing' : ''}`}
                </span>
              </summary>
              <div className="fold-body">
                {gap.candidates.length > 0 ? (
                  <div className="mb-3">
                    <div className="mb-2 text-[11px] text-[var(--ink-2)]">
                      Existing MusicBrainz candidates. Catalogue matches identify a possible work;
                      they do not prove the recording relationship. Opening a work or the recording
                      editor does not write the ledger.
                    </div>
                    {gap.candidates.map((candidate) => {
                      const recorded = gap.ledger.find(
                        (row) =>
                          row.kind === 'work_relationship' && row.workMbid === candidate.workMbid,
                      );
                      return (
                        <div key={candidate.workMbid} className="row px-0">
                          <span className="min-w-0 flex-1">
                            <a
                              href={`https://musicbrainz.org/work/${candidate.workMbid}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {candidate.title}
                            </a>
                            <span className="album-meta">
                              {[candidate.type, candidate.composerName].filter(Boolean).join(' · ')}
                              {candidate.catalogues.length > 0 &&
                                ` · ${candidate.catalogues.map((catalogue) => `${catalogue.system} ${catalogue.number}`).join(', ')}`}
                              {' · '}
                              {candidate.evidence.join(', ')}
                            </span>
                          </span>
                          {recorded ? (
                            <>
                              <span className="album-meta shrink-0">{recorded.label}</span>
                              <button
                                className="act shrink-0"
                                disabled={busy}
                                onClick={() =>
                                  recheckRelationship(gap.recordingMbid, candidate.workMbid)
                                }
                              >
                                Recheck
                              </button>
                            </>
                          ) : (
                            <>
                              <input
                                className="mono w-32 shrink-0"
                                placeholder="edit ID (optional)"
                                value={
                                  (
                                    workRelationshipForms[
                                      `${gap.recordingMbid}:${candidate.workMbid}`
                                    ] ?? { editId: '' }
                                  ).editId
                                }
                                onChange={(event) =>
                                  setWorkRelationshipForms((current) => ({
                                    ...current,
                                    [`${gap.recordingMbid}:${candidate.workMbid}`]: {
                                      editId: event.target.value,
                                    },
                                  }))
                                }
                              />
                              <button
                                className="act shrink-0"
                                data-variant="primary"
                                disabled={busy}
                                onClick={() =>
                                  submittedWorkRelationship(gap.recordingMbid, candidate.workMbid)
                                }
                              >
                                I submitted this link
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="mb-3 text-[var(--ink-2)]">
                    No existing MusicBrainz work is identified by cached MBIDs or an exact catalogue
                    match.
                  </p>
                )}

                {gap.proposals.map((proposal) => (
                  <div
                    key={proposal.localWorkId}
                    className="mb-3 border-l border-[var(--gall)] pl-3"
                  >
                    <div className="text-[11px] text-[var(--gall)]">
                      Proposal only — legacy parser/manual evidence, not MusicBrainz fact
                    </div>
                    <div>
                      <span className="text-[var(--faint)]">Title: </span>
                      <code className="select-all">{proposal.title}</code>
                    </div>
                    <div>
                      <span className="text-[var(--faint)]">Type: </span>
                      {proposal.type ? (
                        <code className="select-all">{proposal.type}</code>
                      ) : (
                        <span className="absent">missing</span>
                      )}
                    </div>
                    <div>
                      <span className="text-[var(--faint)]">Composer: </span>
                      <code className="select-all">{proposal.composerName}</code>
                      {proposal.composerMbid ? (
                        <a
                          className="mono ml-2 text-[11px]"
                          href={`https://musicbrainz.org/artist/${proposal.composerMbid}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          MB
                        </a>
                      ) : (
                        <span className="absent ml-2">MB identity missing</span>
                      )}
                    </div>
                    <div>
                      <span className="text-[var(--faint)]">Catalogue: </span>
                      {proposal.catalogues.length > 0 ? (
                        <code className="select-all">
                          {proposal.catalogues
                            .map((catalogue) => `${catalogue.system} ${catalogue.number}`)
                            .join(', ')}
                        </code>
                      ) : (
                        <span className="absent">missing</span>
                      )}
                    </div>
                  </div>
                ))}
                {gap.proposals.length === 0 && (
                  <p className="mb-3 absent">
                    No local proposal evidence exists for this recording.
                  </p>
                )}

                <div className="mb-3">
                  <div className="mb-2 text-[11px] text-[var(--ink-2)]">
                    Creating a work does not fill the form from the proposal. After you create it on
                    MusicBrainz, paste the new work MBID here. An edit ID is optional and stays
                    missing if you do not have it. Recheck reads the work into our cache; it does
                    not submit anything.
                  </div>
                  {created ? (
                    <div className="row px-0">
                      <span className="min-w-0 flex-1">
                        <a
                          href={`https://musicbrainz.org/work/${created.workMbid}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {created.workMbid}
                        </a>
                        <span className="album-meta">{created.label}</span>
                      </span>
                      <button
                        className="act shrink-0"
                        disabled={busy || !created.workMbid}
                        onClick={() => created.workMbid && recheckWork(created.workMbid)}
                      >
                        Recheck from MusicBrainz
                      </button>
                    </div>
                  ) : (
                    <div className="row px-0">
                      <input
                        className="mono min-w-0 flex-1"
                        placeholder="new work MBID"
                        value={form.workMbid}
                        onChange={(event) =>
                          setWorkCreateForms((current) => ({
                            ...current,
                            [gap.recordingMbid]: { ...form, workMbid: event.target.value },
                          }))
                        }
                      />
                      <input
                        className="mono w-36 shrink-0"
                        placeholder="edit ID (optional)"
                        value={form.editId}
                        onChange={(event) =>
                          setWorkCreateForms((current) => ({
                            ...current,
                            [gap.recordingMbid]: { ...form, editId: event.target.value },
                          }))
                        }
                      />
                      <button
                        className="act shrink-0"
                        data-variant="primary"
                        disabled={busy || form.workMbid.trim() === ''}
                        onClick={() => submittedWorkCreation(gap.recordingMbid)}
                      >
                        I created it
                      </button>
                    </div>
                  )}
                </div>

                <div className="toolbar">
                  <a className="act" href={gap.recordingEdit} target="_blank" rel="noreferrer">
                    Edit recording relationships
                  </a>
                  <a className="act" href={gap.workCreate} target="_blank" rel="noreferrer">
                    Create work
                  </a>
                </div>
              </div>
            </details>
          );
        })}
      </section>

      {view.contested.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">One ISRC, several recordings</span>
            <span className="mono text-[var(--ink-2)]">{view.contested.length}</span>
          </div>
          <p className="px-4 pt-3 text-[var(--ink-2)]">
            An upstream error rather than a gap: an ISRC identifies one recording, so two holding it
            means one of them is wrong. These cost us real links, and they are fixable. Both
            recordings stay listed. Opening a recording or the ISRC page does not write the ledger,
            and nothing here removes the cached mapping.
          </p>
          {view.contested.map((row) => (
            <div key={row.isrc} className="row">
              <span className="min-w-0 flex-1">
                <a className="mono" href={row.isrcUrl} target="_blank" rel="noreferrer">
                  {row.isrc}
                </a>
                <span className="block text-[11px] text-[var(--ink-2)]">{row.titles}</span>
                <span className="album-meta">
                  {row.recordingMbids.map((mbid) => (
                    <a
                      key={mbid}
                      className="mono"
                      href={`https://musicbrainz.org/recording/${mbid}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {mbid}
                    </a>
                  ))}
                </span>
              </span>
              {row.ledger ? (
                <>
                  <span className="album-meta shrink-0">
                    {row.ledger.disposition} · {row.ledger.label}
                  </span>
                  <button
                    className="act shrink-0"
                    disabled={busy}
                    onClick={() => recheckError('contested_isrc', row.isrc)}
                  >
                    Recheck
                  </button>
                </>
              ) : (
                <>
                  <input
                    className="mono w-32 shrink-0"
                    placeholder="edit ID (optional)"
                    value={(errorForms[row.isrc] ?? { editId: '' }).editId}
                    onChange={(event) =>
                      setErrorForms((current) => ({
                        ...current,
                        [row.isrc]: { editId: event.target.value },
                      }))
                    }
                  />
                  <button
                    className="act shrink-0"
                    data-variant="primary"
                    disabled={busy}
                    onClick={() => submittedContestedIsrc(row.isrc, 'reported')}
                  >
                    I reported it
                  </button>
                  <button
                    className="act shrink-0"
                    disabled={busy}
                    onClick={() => submittedContestedIsrc(row.isrc, 'fixed')}
                  >
                    I fixed it
                  </button>
                </>
              )}
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
            MusicBrainz shows it in the cache — ISRCs, barcodes, streaming URLs, releases, works,
            relationships, and reported contradictions. Unfetched streaming URLs stay pending.
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
