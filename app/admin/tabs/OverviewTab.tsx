'use client';

import { useEffect, useState } from 'react';
import type { ReadinessBucket, ReadinessFunnel, ReadinessStep } from '@/lib/catalogue-readiness';
import { getReadinessFunnel } from '../actions/readiness';
import { adminFailureMessage, LoadFailure } from '../components/AdminFailure';
import { Spinner } from '../components/Spinner';
import type { InboxClass } from '../lib/admin-url';

/**
 * One question: how many of the library's tracks can the player show, and
 * which MusicBrainz edits would show the rest.
 *
 * Every track is counted once — ready, not classical, or blocked at the
 * first step it fails — so the numbers on this page add up to the library.
 */
export function OverviewTab({ onOpenInbox }: { onOpenInbox: (inboxClass: InboxClass) => void }) {
  const [funnel, setFunnel] = useState<ReadinessFunnel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getReadinessFunnel()
      .then((next) => {
        if (!cancelled) setFunnel(next);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(adminFailureMessage(failure));
      });
    return () => {
      cancelled = true;
    };
    // attempt is only a dependency: Retry bumps it to load again.
  }, [attempt]);

  if (!funnel) {
    if (error !== null) {
      return (
        <LoadFailure
          what="library readiness"
          error={error}
          onRetry={() => {
            setError(null);
            setAttempt((n) => n + 1);
          }}
        />
      );
    }
    return (
      <div className="flex items-center gap-2 py-16 text-[var(--faint)]">
        <Spinner className="h-3 w-3" />
        <span className="text-xs">Reading every track in the library…</span>
      </div>
    );
  }

  const share = funnel.inScope ? Math.floor((funnel.ready / funnel.inScope) * 100) : 0;

  return (
    <div className="flex flex-col gap-6 pb-16">
      <section className="panel px-4 py-4">
        <p className="eyebrow mb-2">Ready to show in the player</p>
        <p className="mono text-[26px] leading-none">
          {funnel.ready.toLocaleString()}
          <span className="ml-3 text-[13px] text-[var(--faint)]">
            of {funnel.inScope.toLocaleString()} tracks ({share}%)
          </span>
        </p>
        <div className="mt-3 flex h-1.5 w-full overflow-hidden bg-[var(--slip-2)]">
          <div className="bg-[var(--viridian)]" style={{ width: `${share}%` }} />
        </div>
        <p className="mt-3 max-w-[80ch] text-[var(--ink-2)]">
          A track is ready when it is linked to a MusicBrainz recording, the recording is linked to
          a work, the work the player files it under has a composer, and MusicBrainz marks the work
          as classical (a catalogue number or a classical work type). Each track below is counted
          once, at the first of those it is missing.
        </p>

        <table className="readiness-funnel mt-4">
          <tbody>
            <tr>
              <td className="mono">{funnel.total.toLocaleString()}</td>
              <td>tracks in the library</td>
              <td />
            </tr>
            <tr className="text-[var(--ink-2)]">
              <td className="mono">−{funnel.notClassical.toLocaleString()}</td>
              <td>not classical — excluded, they need no work</td>
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
                  {step.blocked > 0 && (
                    <a href={`#readiness-${step.key}`}>{step.blocked.toLocaleString()} stop here</a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {funnel.steps
        .filter((step) => step.blocked > 0)
        .map((step) => (
          <StepPanel key={step.key} step={step} onOpenInbox={onOpenInbox} />
        ))}
    </div>
  );
}

const MISSING: Record<ReadinessStep['key'], string> = {
  recording: 'Not linked to a MusicBrainz recording',
  work: 'Recording not linked to a work',
  composer: 'Work has no composer',
  classical: 'Not recognised as classical',
};

function StepPanel({
  step,
  onOpenInbox,
}: {
  step: ReadinessStep;
  onOpenInbox: (inboxClass: InboxClass) => void;
}) {
  return (
    <section id={`readiness-${step.key}`} className="panel scroll-mt-28">
      <div className="panel-head">
        <h2 className="panel-title">{MISSING[step.key]}</h2>
        <span className="mono text-[var(--ink-2)]">{step.blocked.toLocaleString()} tracks</span>
      </div>
      {step.buckets.map((bucket) => (
        <BucketRow key={bucket.key} bucket={bucket} onOpenInbox={onOpenInbox} />
      ))}
    </section>
  );
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

function BucketRow({
  bucket,
  onOpenInbox,
}: {
  bucket: ReadinessBucket;
  onOpenInbox: (inboxClass: InboxClass) => void;
}) {
  const outstanding = bucket.tracks - bucket.waiting;
  return (
    <div className="row items-start">
      <span
        className={`mono w-14 shrink-0 text-[15px] ${
          bucket.kind === 'action' ? 'text-[var(--gall)]' : 'text-[var(--ink-2)]'
        }`}
      >
        {bucket.tracks.toLocaleString()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block">{bucket.label}</span>
        <span className="block text-[11px] text-[var(--ink-2)]">
          {bucket.detail} {plural(bucket.groups, bucket.groupNoun)}.
          {bucket.waiting > 0 &&
            ` ${bucket.waiting.toLocaleString()} submitted, waiting; ${outstanding.toLocaleString()} outstanding.`}
        </span>
        {bucket.inboxClass === null && bucket.examples.length > 0 && (
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
      {bucket.inboxClass && (
        <button
          className="act shrink-0"
          data-variant="primary"
          onClick={() => onOpenInbox(bucket.inboxClass!)}
        >
          Open in Inbox
        </button>
      )}
    </div>
  );
}
