'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ReadinessBucket, ReadinessFunnel } from '@/lib/catalogue-readiness';
import type { ContributionView } from '../actions/contribute';
import { getAdminHome } from '../actions/readiness';
import { adminFailureMessage, LoadFailure } from '../components/AdminFailure';
import { Spinner } from '../components/Spinner';
import { PAGE_TITLE } from '../lib/admin-pages';
import { adminHref, type InboxClass, type ToolPage } from '../lib/admin-url';

type Counts = ContributionView['counts'];
type Held = { tracks: number; waiting: number };

/** Tracks each Inbox list holds back from the player, from the readiness count. */
function heldBackByInboxClass(funnel: ReadinessFunnel): Partial<Record<InboxClass, Held>> {
  const held: Partial<Record<InboxClass, Held>> = {};
  for (const bucket of funnel.steps.flatMap((step) => step.buckets)) {
    if (!bucket.inboxClass) continue;
    const entry = held[bucket.inboxClass] ?? { tracks: 0, waiting: 0 };
    entry.tracks += bucket.tracks;
    entry.waiting += bucket.waiting;
    held[bucket.inboxClass] = entry;
  }
  return held;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Each row's number counts the same rows its page lists, in the page's own
 * unit. What a list costs the player — tracks it holds back — is said beside
 * it, and only for the lists that can hold a track back at all.
 */
const LISTS: {
  page: InboxClass;
  rows: (counts: Counts) => string;
  holdsBack: boolean;
}[] = [
  { page: 'missing', rows: (counts) => plural(counts.missingReleases, 'album'), holdsBack: true },
  { page: 'misaligned', rows: (counts) => plural(counts.misaligned, 'album'), holdsBack: true },
  {
    page: 'work',
    rows: (counts) => plural(counts.workRelationships, 'recording'),
    holdsBack: true,
  },
  { page: 'contested', rows: (counts) => plural(counts.contestedIsrcs, 'ISRC'), holdsBack: true },
  {
    page: 'isrc',
    rows: (counts) =>
      `${plural(counts.isrc, 'track')} on ${plural(counts.isrcReleases, 'release')}`,
    holdsBack: false,
  },
  { page: 'barcodes', rows: (counts) => plural(counts.barcodes, 'release'), holdsBack: false },
  {
    page: 'streaming',
    rows: (counts) => plural(counts.streamingUrls, 'release'),
    holdsBack: false,
  },
  {
    page: 'submitted',
    rows: (counts) => `${plural(counts.submissions.pending ?? 0, 'edit')} pending`,
    holdsBack: false,
  },
];

const TOOLS: { page: ToolPage; note: string }[] = [
  { page: 'albums', note: 'Every album, filtered by how far MusicBrainz has it.' },
  { page: 'corrections', note: 'What we had to fix by hand after a Harmony import.' },
  { page: 'refresh-work', note: 'Read one work again, after you edit it on MusicBrainz.' },
  { page: 'checks', note: 'Cache checks, and which commit is live.' },
];

/**
 * The admin home: how much of the library the player can show, and one line
 * per list of things to fix, each opening its own page.
 */
export function AdminHome() {
  const [funnel, setFunnel] = useState<ReadinessFunnel | null>(null);
  const [funnelError, setFunnelError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getAdminHome()
      .then((next) => {
        if (cancelled) return;
        setFunnel(next.funnel.value);
        setFunnelError(next.funnel.error);
        setCounts(next.counts.value);
        setCountsError(next.counts.error);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setFunnelError(adminFailureMessage(failure));
        setCountsError(adminFailureMessage(failure));
      });
    return () => {
      cancelled = true;
    };
    // attempt is only a dependency: Retry bumps it to load again.
  }, [attempt]);

  const retry = () => {
    setFunnelError(null);
    setCountsError(null);
    setAttempt((n) => n + 1);
  };

  const held = funnel ? heldBackByInboxClass(funnel) : null;
  const heldNote = (page: InboxClass) => {
    if (funnelError !== null) return 'Tracks held back: could not be counted.';
    if (!held) return 'Counting tracks held back…';
    const entry = held[page] ?? { tracks: 0, waiting: 0 };
    return (
      `${plural(entry.tracks, 'track')} held back from the player.` +
      (entry.waiting > 0 ? ` ${entry.waiting.toLocaleString()} of them submitted, waiting.` : '')
    );
  };
  const elsewhere = funnel
    ? funnel.steps.flatMap((step) => step.buckets).filter((bucket) => bucket.inboxClass === null)
    : [];

  return (
    <div className="flex flex-col gap-6 pb-16">
      <ReadyPanel funnel={funnel} error={funnelError} onRetry={retry} />

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">To fix on MusicBrainz</h2>
        </div>
        {countsError !== null && (
          <LoadFailure what="the lists" error={countsError} onRetry={retry} />
        )}
        {LISTS.map(({ page, rows, holdsBack }) => (
          <PageRow
            key={page}
            href={adminHref(page)}
            count={counts ? rows(counts) : countsError !== null ? '?' : '…'}
            title={PAGE_TITLE[page]}
            note={
              holdsBack ? heldNote(page) : page === 'submitted' ? null : 'Holds back no tracks.'
            }
            quiet={!holdsBack}
          />
        ))}
      </section>

      {elsewhere.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Held back for other reasons</h2>
            <span className="text-[var(--ink-2)]">No list here can fix these yet.</span>
          </div>
          {elsewhere.map((bucket) => (
            <BucketRow key={bucket.key} bucket={bucket} />
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Tools</h2>
        </div>
        {TOOLS.map(({ page, note }) => (
          <PageRow key={page} href={adminHref(page)} title={PAGE_TITLE[page]} note={note} quiet />
        ))}
      </section>
    </div>
  );
}

function PageRow({
  href,
  count,
  title,
  note,
  quiet = false,
}: {
  href: string;
  count?: string;
  title: string;
  note?: React.ReactNode;
  quiet?: boolean;
}) {
  return (
    <Link href={href} className="row items-start no-underline">
      <span className="min-w-0 flex-1">
        <span className="block text-[var(--ink)]">{title}</span>
        {note && <span className="block text-[11px] text-[var(--ink-2)]">{note}</span>}
      </span>
      {count !== undefined && (
        <span
          className={`mono shrink-0 text-right ${
            quiet || count.startsWith('0 ') ? 'text-[var(--ink-2)]' : 'text-[var(--gall)]'
          }`}
        >
          {count}
        </span>
      )}
      <span aria-hidden="true" className="shrink-0 text-[var(--faint)]">
        →
      </span>
    </Link>
  );
}

function ReadyPanel({
  funnel,
  error,
  onRetry,
}: {
  funnel: ReadinessFunnel | null;
  error: string | null;
  onRetry: () => void;
}) {
  if (!funnel) {
    if (error !== null)
      return <LoadFailure what="library readiness" error={error} onRetry={onRetry} />;
    return (
      <div className="flex items-center gap-2 py-6 text-[var(--faint)]">
        <Spinner className="h-3 w-3" />
        <span className="text-xs">Reading every track in the library…</span>
      </div>
    );
  }

  const share = funnel.inScope ? Math.floor((funnel.ready / funnel.inScope) * 100) : 0;
  return (
    <section className="panel px-4 py-4">
      <p className="eyebrow mb-2">Ready to show in the player</p>
      <p className="mono text-[26px] leading-none">
        {funnel.ready.toLocaleString()}
        <span className="ml-3 text-[13px] text-[var(--faint)]">
          of {funnel.inScope.toLocaleString()} classical tracks ({share}%)
        </span>
      </p>
      <div className="mt-3 flex h-1.5 w-full overflow-hidden bg-[var(--slip-2)]">
        <div className="bg-[var(--viridian)]" style={{ width: `${share}%` }} />
      </div>
      {funnel.readyViaOwnLinks > 0 && (
        <p className="mt-3 text-[var(--ink-2)]">
          {funnel.readyViaOwnLinks.toLocaleString()} of the ready tracks are filed under a work by
          our own match, not by MusicBrainz.
        </p>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-[var(--ink-2)]">
          How a track counts as ready
        </summary>
        <p className="mt-2 max-w-[80ch] text-[var(--ink-2)]">
          A track is ready when it is linked to a MusicBrainz recording, the recording is linked to
          a work, the work the player files it under has a composer, and MusicBrainz marks the work
          as classical (a catalogue number or a classical work type). Where MusicBrainz has no
          recording or no work link yet, our own match to a work stands in. Each track is counted
          once, at the first of those it is missing.
        </p>
        <table className="readiness-funnel mt-3">
          <tbody>
            <tr>
              <td className="mono">{funnel.total.toLocaleString()}</td>
              <td>tracks in the library</td>
              <td />
            </tr>
            <tr className="text-[var(--ink-2)]">
              <td className="mono">−{funnel.notClassical.toLocaleString()}</td>
              <td>not classical, so left out</td>
              <td />
            </tr>
            <tr>
              <td className="mono">{funnel.inScope.toLocaleString()}</td>
              <td>to make ready</td>
              <td />
            </tr>
            {funnel.steps.map((step) => (
              <tr key={step.key}>
                <td className="mono">{step.reached.toLocaleString()}</td>
                <td>{step.label}</td>
                <td className="mono text-[var(--gall)]">
                  {step.blocked > 0 && `${step.blocked.toLocaleString()} stop here`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

/** A group of held-back tracks no Inbox list covers, with examples to look at. */
function BucketRow({ bucket }: { bucket: ReadinessBucket }) {
  const outstanding = bucket.tracks - bucket.waiting;
  return (
    <div className="row items-start">
      <span className="mono w-14 shrink-0 text-right text-[15px] text-[var(--ink-2)]">
        {bucket.tracks.toLocaleString()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block">{bucket.label}</span>
        <span className="block text-[11px] text-[var(--ink-2)]">
          {bucket.detail} {plural(bucket.groups, bucket.groupNoun)}.
          {bucket.waiting > 0 &&
            ` ${bucket.waiting.toLocaleString()} submitted, waiting; ${outstanding.toLocaleString()} outstanding.`}
        </span>
        {bucket.examples.length > 0 && (
          <span className="mt-1 block text-[11px]">
            {bucket.examples.map((example, index) => (
              <span key={example.href}>
                {index > 0 && <span className="text-[var(--faint)]"> · </span>}
                <a
                  className="text-[var(--viridian)]"
                  href={example.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {example.label ?? <span className="absent">untitled</span>}
                </a>
                <span className="mono text-[var(--faint)]"> {example.tracks}</span>
              </span>
            ))}
            {bucket.groups > bucket.examples.length && (
              <span className="text-[var(--faint)]">
                {' '}
                · {(bucket.groups - bucket.examples.length).toLocaleString()} more
              </span>
            )}
          </span>
        )}
      </span>
      {bucket.kind === 'ours' && <span className="tag shrink-0">waiting on our cache</span>}
      {bucket.kind === 'unknown' && <span className="tag shrink-0">needs investigation</span>}
      {bucket.waiting > 0 && <span className="tag shrink-0">submitted, waiting</span>}
    </div>
  );
}
