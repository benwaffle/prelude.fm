'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CONTRIBUTION_LIMITS,
  nextListLimit,
  type ContributionListLimits,
} from '@/lib/contribution-list';
import { getBotStatus, type BotStatus } from '../actions/bot';
import { getContributions, type ContributionView } from '../actions/inbox-view';
import { Spinner } from '../components/Spinner';
import { afterAdminBurst } from '../components/admin-action-queue';
import { failureMessage } from '@/lib/use-server-query';
import { LoadFailure } from '@/app/components/LoadFailure';
import { noticeClassName } from '../components/Notice';
import { useAdminFailure } from '../components/AdminFailure';
import type { InboxClass } from '../lib/admin-url';
import type { InboxFocus } from '../lib/inbox-focus';
import { BarcodesSection } from './BarcodesSection';
import { ContestedIsrcsSection } from './ContestedIsrcsSection';
import { IsrcSection } from './IsrcSection';
import { MisalignedSection } from './MisalignedSection';
import { MissingReleasesSection } from './MissingReleasesSection';
import { StreamingUrlsSection } from './StreamingUrlsSection';
import { SubmittedSection } from './SubmittedSection';
import { WorkRelationshipsSection } from './WorkRelationshipsSection';

export function InboxSectionPage({
  section,
  focus = null,
}: {
  section: InboxClass;
  focus?: InboxFocus | null;
}) {
  const [view, setView] = useState<ContributionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const usesBot = section === 'isrc' || section === 'barcodes';
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [botError, setBotError] = useState<string | null>(null);
  const [limits, setLimits] = useState<ContributionListLimits>(DEFAULT_CONTRIBUTION_LIMITS);
  const handledFocus = useRef<string | null>(null);

  const { showFailure } = useAdminFailure();

  // During a burst of queued actions only the last one reloads, so rows don't flicker or move
  // mid-burst.
  const reload = useCallback(
    () =>
      afterAdminBurst(
        'inbox-reload',
        async () => {
          setView(await getContributions(limits, section));
          setLoadError(null);
        },
        showFailure,
      ),
    [limits, section, showFailure],
  );

  useEffect(() => {
    let cancelled = false;
    void getContributions(limits, section)
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(failureMessage(error));
      });
    return () => {
      cancelled = true;
    };
    // loadAttempt is only a dependency: Retry bumps it to run this load again.
  }, [limits, section, loadAttempt]);

  useEffect(() => {
    if (!usesBot) return;
    getBotStatus()
      .then(setBot)
      .catch((error: unknown) => setBotError(failureMessage(error)));
  }, [usesBot]);

  useEffect(() => {
    if (!view || !focus) return;
    const target = `${focus.kind}:${focus.id}`;
    if (handledFocus.current === target) return;
    const selector =
      focus.kind === 'release'
        ? `[data-inbox-release="${CSS.escape(focus.id)}"]`
        : `[data-inbox-album="${CSS.escape(focus.id)}"]`;
    const element = document.querySelector(selector);
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      handledFocus.current = target;
    }
  }, [focus, view]);

  function loadMore(key: keyof ContributionListLimits, total: number) {
    setLimits((current) => ({
      ...current,
      [key]: nextListLimit(current[key], total),
    }));
  }

  const failure = loadError !== null && (
    <LoadFailure
      className={noticeClassName('error')}
      what="this list"
      error={loadError}
      onRetry={() => {
        setLoadError(null);
        setLoadAttempt((attempt) => attempt + 1);
      }}
    />
  );

  if (!view) return failure || <Spinner className="h-4 w-4" />;

  return (
    <div className="flex flex-col gap-4 pb-16">
      {failure}
      {section !== 'submitted' && (
        <p className="max-w-[90ch] text-[var(--ink-2)]">
          Opening a MusicBrainz, Harmony, or MagicISRC link writes nothing. Confirming records it as
          submitted. Recheck reads the cache.
        </p>
      )}

      {usesBot && (
        <div className="bot-cap-strip">
          <span className="tag">BOT</span>
          <span className="panel-title">prelude_fm_bot</span>
          <span className="mono">
            {bot
              ? `${bot.spentToday} / ${bot.dailyCap} edits today`
              : botError === null
                ? 'Loading bot status…'
                : `bot status unavailable: ${botError}`}
          </span>
          <span className="text-[var(--ink-2)]">
            {bot ? (bot.configured ? 'configured' : 'not configured') : '—'} · ISRCs and barcodes
            share this cap
          </span>
        </div>
      )}

      {section === 'missing' && (
        <MissingReleasesSection
          rows={view.missing}
          total={view.counts.missingReleases}
          onReload={reload}
          onLoadMore={() => loadMore('missing', view.counts.missingReleases)}
        />
      )}
      {section === 'misaligned' && (
        <MisalignedSection
          rows={view.misaligned}
          total={view.counts.misaligned}
          onReload={reload}
          onLoadMore={() => loadMore('misaligned', view.counts.misaligned)}
        />
      )}
      {section === 'isrc' && (
        <IsrcSection
          rows={view.isrcReleases}
          trackTotal={view.counts.isrc}
          releaseTotal={view.counts.isrcReleases}
          bot={bot}
          onReload={reload}
          onBotChange={setBot}
          onLoadMore={() => loadMore('isrcReleases', view.counts.isrcReleases)}
        />
      )}
      {section === 'barcodes' && (
        <BarcodesSection
          rows={view.barcodes}
          total={view.counts.barcodes}
          bot={bot}
          onReload={reload}
          onBotChange={setBot}
          onLoadMore={() => loadMore('barcodes', view.counts.barcodes)}
        />
      )}
      {section === 'work' && (
        <WorkRelationshipsSection
          rows={view.workGaps}
          total={view.counts.workRelationships}
          onReload={reload}
          onLoadMore={() => loadMore('workGaps', view.counts.workRelationships)}
        />
      )}
      {section === 'streaming' && (
        <StreamingUrlsSection
          rows={view.streamingUrls}
          total={view.counts.streamingUrls}
          onReload={reload}
          onLoadMore={() => loadMore('streamingUrls', view.counts.streamingUrls)}
        />
      )}
      {section === 'contested' && (
        <ContestedIsrcsSection
          rows={view.contested}
          total={view.counts.contestedIsrcs}
          onReload={reload}
          onLoadMore={() => loadMore('contested', view.counts.contestedIsrcs)}
        />
      )}
      {section === 'submitted' && (
        <SubmittedSection rows={view.recent} counts={view.counts.submissions} onReload={reload} />
      )}
    </div>
  );
}
