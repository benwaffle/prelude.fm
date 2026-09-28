'use client';

import { useEffect, useState } from 'react';
import {
  getReleaseCorrections,
  measureReleaseCorrections,
  type ReleaseCorrectionsView,
} from '../actions/contribute';
import { adminFailureMessage, LoadFailure } from '../components/AdminFailure';
import { Spinner } from '../components/Spinner';
import { useAdminAction } from '../components/useAdminAction';
import { RowActionStatus } from '../inbox/RowActionStatus';
import {
  ALBUM_KIND_LABELS,
  CORRECTION_LABELS,
  type ReleaseCorrectionRecord,
} from '@/lib/release-corrections';

const BASELINE_LABEL: Record<ReleaseCorrectionRecord['baselineSource'], string> = {
  precheck: 'the Spotify album as read by the pre-check',
  spotify: 'the Spotify album, read when measuring (no pre-check was stored)',
  library: 'our stored copy of the Spotify album (Spotify could not be read; no album artist)',
  'prelude-seed':
    'the form prelude.fm seeded (our credits and pre-filled recordings), because the Seed on MusicBrainz button was used',
};

/**
 * What people had to change when adding releases through Harmony, by kind
 * of album — the evidence for which kinds a bot could one day add alone.
 */
export function ReleaseCorrectionsTab() {
  const [view, setView] = useState<ReleaseCorrectionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { runRow, row } = useAdminAction();

  useEffect(() => {
    let cancelled = false;
    getReleaseCorrections()
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(adminFailureMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function measure(albumId: string) {
    await runRow(albumId, 'Measuring what changed…', async () => {
      await measureReleaseCorrections(albumId);
      setView(await getReleaseCorrections());
    });
  }

  if (!view) {
    if (error !== null) return <LoadFailure what="release corrections" error={error} />;
    return <Spinner className="h-3 w-3" />;
  }

  return (
    <div className="flex flex-col gap-6 text-[12px]">
      <p className="max-w-[90ch] text-[var(--ink-2)]">
        Each release added through the Inbox is compared with what Harmony would have seeded from
        Spotify: its track titles, its artists, a new recording for every track, and a new album
        group. Any difference is counted as a correction. Harmony can also merge in other stores’
        data, so a difference is usually, but not certainly, a person’s fix.
      </p>

      <section>
        <p className="eyebrow mb-2">By kind of album</p>
        {view.summary.length === 0 ? (
          <p className="absent">No releases measured yet.</p>
        ) : (
          <table className="w-full text-left">
            <thead className="text-[var(--ink-2)]">
              <tr>
                <th className="pr-4 font-normal">Kind</th>
                <th className="pr-4 font-normal">Albums</th>
                <th className="pr-4 font-normal">Needed nothing</th>
                <th className="font-normal">Most common changes</th>
              </tr>
            </thead>
            <tbody>
              {view.summary.map((summary) => (
                <tr key={summary.kind} className="align-top">
                  <td className="pr-4">{ALBUM_KIND_LABELS[summary.kind]}</td>
                  <td className="mono pr-4">{summary.albums}</td>
                  <td className="pr-4">
                    <span className="mono">{summary.untouched}</span>
                    {summary.untouchedIncomplete > 0 && (
                      <span className="album-meta block">
                        +{summary.untouchedIncomplete} with nothing found but some checks couldn’t
                        tell
                      </span>
                    )}
                  </td>
                  <td>
                    {summary.byType.length === 0
                      ? '—'
                      : summary.byType
                          .slice(0, 4)
                          .map(
                            (entry) =>
                              `${CORRECTION_LABELS[entry.type]} (${entry.albums} of ${summary.albums})`,
                          )
                          .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {view.unmeasured.length > 0 && (
        <section>
          <p className="eyebrow mb-2">Added but not measured</p>
          {view.unmeasured.map((album) => (
            <div key={album.albumId} className="flex items-baseline gap-3 py-1">
              <span className="min-w-0 flex-1">
                {album.albumTitle}
                <RowActionStatus row={row(album.albumId)} />
              </span>
              <button
                className="act"
                disabled={row(album.albumId).busy}
                onClick={() => measure(album.albumId)}
              >
                Measure
              </button>
            </div>
          ))}
        </section>
      )}

      <section>
        <p className="eyebrow mb-2">Each release</p>
        {view.rows.length === 0 && <p className="absent">None yet.</p>}
        {view.rows.map(({ albumId, albumTitle, record, measuredAt }) => (
          <details key={albumId} className="rule-b py-2">
            <summary className="cursor-pointer">
              <span>{albumTitle ?? albumId}</span>{' '}
              <span className="tag">{ALBUM_KIND_LABELS[record.kind]}</span>{' '}
              <span className="album-meta">
                {record.corrections.length === 0
                  ? record.incomplete.length === 0
                    ? 'no corrections'
                    : 'no corrections found, some checks couldn’t tell'
                  : record.corrections.map((type) => CORRECTION_LABELS[type]).join(' · ')}
              </span>
            </summary>
            <CorrectionDetail record={record} />
            <div className="mt-2 flex items-baseline gap-3">
              <span className="album-meta flex-1">
                Measured {new Date(measuredAt).toLocaleString()} ·{' '}
                <a
                  href={`https://musicbrainz.org/release/${record.releaseMbid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  release
                </a>
                <RowActionStatus row={row(albumId)} />
              </span>
              <button className="act" disabled={row(albumId).busy} onClick={() => measure(albumId)}>
                Measure again
              </button>
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}

function CorrectionDetail({ record }: { record: ReleaseCorrectionRecord }) {
  const { tracks, titles, trackArtists, recordings } = record;
  return (
    <div className="mt-2 flex flex-col gap-2 pl-3">
      <p>
        Kind: {ALBUM_KIND_LABELS[record.kind]} — {record.kindWhy}. Compared with{' '}
        {BASELINE_LABEL[record.baselineSource]}.
      </p>
      <ul className="list-disc pl-5">
        <li>
          Tracks: {tracks.seeded} seeded, {tracks.landed} landed; {tracks.added} added,{' '}
          {tracks.removed} removed, {tracks.moved} reordered ({tracks.paired} paired —{' '}
          {tracks.pairedBy.isrc} by ISRC, {tracks.pairedBy.position} by position,{' '}
          {tracks.pairedBy.duration} by length).
        </li>
        <li>
          Track titles: {titles.changed} reworded, {titles.punctuationOnly} punctuation only.
          {titles.examples.length > 0 && (
            <ul className="list-disc pl-5">
              {titles.examples.map((example, index) => (
                <li key={index}>
                  “{example.from}” → “{example.to}”
                </li>
              ))}
            </ul>
          )}
        </li>
        <li>
          Track artists: {trackArtists.changed} of {tracks.paired} changed.
          {trackArtists.examples.length > 0 && (
            <ul className="list-disc pl-5">
              {trackArtists.examples.map((example, index) => (
                <li key={index}>
                  {example.from.join(', ') || '(none)'} → {example.to.join(', ') || '(none)'}
                </li>
              ))}
            </ul>
          )}
        </li>
        <li>
          Album: title{' '}
          {record.albumTitle.changed
            ? `“${record.albumTitle.from}” → “${record.albumTitle.to}”`
            : 'unchanged'}
          ; artist{' '}
          {record.releaseArtist === null
            ? 'not compared (no album artist in the seed)'
            : record.releaseArtist.changed
              ? `${record.releaseArtist.from.join(', ')} → ${record.releaseArtist.to.join(', ')}`
              : 'unchanged'}
          ; album group{' '}
          {record.releaseGroup === 'reused'
            ? 'existing'
            : record.releaseGroup === 'new'
              ? 'new'
              : 'couldn’t tell'}
          .
        </li>
        <li>
          Recordings: {recordings.reused} reused, {recordings.created} new
          {recordings.unknown > 0 && `, ${recordings.unknown} couldn’t tell`}. Of the new ones,{' '}
          {recordings.titleChanged} retitled and {recordings.artistsChanged} with changed artists.
          {recordings.seededKept !== undefined &&
            (recordings.seededKept > 0 || (recordings.seededReplaced ?? 0) > 0) &&
            ` Pre-filled: ${recordings.seededKept} kept, ${recordings.seededReplaced ?? 0} replaced.`}
        </li>
      </ul>
      {record.incomplete.length > 0 && (
        <p className="absent">Not measured: {record.incomplete.join('; ')}.</p>
      )}
    </div>
  );
}
