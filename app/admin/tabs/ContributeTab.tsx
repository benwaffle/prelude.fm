'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getContributions,
  recordIsrcSubmission,
  reconcileSubmissions,
  setSubmissionOutcome,
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

  const refresh = useCallback(() => {
    getContributions()
      .then(setView)
      .catch(() => setView(null));
  }, []);

  useEffect(refresh, [refresh]);

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
                {release.missing} missing · barcode matches · durations within 3s
              </span>
            </summary>
            <div className="fold-body">
              <table>
                <thead>
                  <tr>
                    <th>Disc/track</th>
                    <th>Recording</th>
                    <th>ISRC</th>
                    <th>Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {release.tracks.map((track) => (
                    <tr key={`${track.medium}-${track.position}`}>
                      <td className="mono">
                        {track.medium}-{track.position}
                      </td>
                      <td>{track.title}</td>
                      <td className="mono">{track.isrc}</td>
                      <td className="mono">{track.delta}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="toolbar">
                <a className="act" href={release.link} target="_blank" rel="noreferrer">
                  Open in MagicISRC
                </a>
                <button
                  className="act"
                  disabled={busy}
                  onClick={() => submitted(release.releaseMbid)}
                >
                  I submitted these
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
            </div>
          </details>
        ))}
      </section>

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
