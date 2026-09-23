'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CONTRIBUTION_LIMITS,
  nextListLimit,
  type ContributionListLimits,
} from '@/lib/contribution-list';
import {
  getBotStatus,
  getContributions,
  type BotStatus,
  type ContributionView,
} from '../actions/contribute';
import { Spinner } from '../components/Spinner';
import { useAdminFailure } from '../components/AdminFailure';
import type { InboxClass } from '../lib/admin-url';
import type { InboxFocus } from '../lib/inbox-focus';
import { BarcodesSection } from '../inbox/BarcodesSection';
import { ContestedIsrcsSection } from '../inbox/ContestedIsrcsSection';
import { InboxStage } from '../inbox/InboxSection';
import { IsrcSection } from '../inbox/IsrcSection';
import { MisalignedSection } from '../inbox/MisalignedSection';
import { MissingReleasesSection } from '../inbox/MissingReleasesSection';
import { StreamingUrlsSection } from '../inbox/StreamingUrlsSection';
import { SubmittedSection } from '../inbox/SubmittedSection';
import { TriageHeader } from '../inbox/TriageHeader';
import { WorkRelationshipsSection } from '../inbox/WorkRelationshipsSection';

export function ContributeTab({
  focus = null,
  inboxClass,
  onClassChange,
}: {
  focus?: InboxFocus | null;
  inboxClass?: InboxClass;
  onClassChange?: (inboxClass: InboxClass) => void;
}) {
  const { clearFailure, showFailure } = useAdminFailure();
  const [view, setView] = useState<ContributionView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [botLoadFailed, setBotLoadFailed] = useState(false);
  const [limits, setLimits] = useState<ContributionListLimits>(DEFAULT_CONTRIBUTION_LIMITS);
  const handledTarget = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const next = await getContributions(limits);
    setView(next);
    setLoadFailed(false);
  }, [limits]);

  useEffect(() => {
    let cancelled = false;
    void getContributions(limits)
      .then((next) => {
        if (!cancelled) {
          setView(next);
          setLoadFailed(false);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadFailed(true);
          showFailure(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [limits, showFailure]);

  useEffect(() => {
    getBotStatus()
      .then((next) => {
        setBot(next);
        setBotLoadFailed(false);
      })
      .catch((error: unknown) => {
        setBotLoadFailed(true);
        showFailure(error);
      });
  }, [showFailure]);

  useEffect(() => {
    if (!view) return;
    const target = focus ? `${focus.kind}:${focus.id}` : inboxClass ? `class:${inboxClass}` : null;
    if (!target || handledTarget.current === target) return;
    const selector = focus
      ? focus.kind === 'release'
        ? `[data-inbox-release="${CSS.escape(focus.id)}"]`
        : `[data-inbox-album="${CSS.escape(focus.id)}"]`
      : `#inbox-${inboxClass}`;
    const element = document.querySelector(selector);
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      handledTarget.current = target;
    }
  }, [focus, inboxClass, view]);

  function loadMore(key: keyof ContributionListLimits, total: number) {
    clearFailure();
    setLimits((current) => ({
      ...current,
      [key]: nextListLimit(current[key], total),
    }));
  }

  if (!view)
    return loadFailed ? (
      <button
        className="act"
        onClick={() => {
          clearFailure();
          setLoadFailed(false);
          void reload().catch((error: unknown) => {
            setLoadFailed(true);
            showFailure(error);
          });
        }}
      >
        Retry Inbox load
      </button>
    ) : (
      <Spinner className="h-4 w-4" />
    );

  const botChanged = (nextBot: BotStatus) => {
    setBot(nextBot);
  };

  return (
    <div className="flex flex-col gap-6 pb-16">
      <p className="max-w-[90ch] text-[var(--ink-2)]">
        Opening a MusicBrainz, Harmony, or MagicISRC link writes nothing. Confirm writes the ledger.
        Recheck reads the cache.
      </p>

      <TriageHeader counts={view.counts} activeClass={inboxClass} onClassChange={onClassChange} />

      <div className="bot-cap-strip">
        <span className="tag">BOT</span>
        <span className="panel-title">prelude_fm_bot</span>
        <span className="mono">
          {bot
            ? `${bot.spentToday} / ${bot.dailyCap} edits today`
            : botLoadFailed
              ? 'bot status unavailable'
              : 'Loading bot status…'}
        </span>
        <span className="text-[var(--ink-2)]">
          {bot ? (bot.configured ? 'configured' : 'not configured') : '—'} · ISRCs and barcodes
          share this cap
        </span>
      </div>

      <InboxStage label="Get the release">
        <MissingReleasesSection
          rows={view.missing}
          total={view.counts.missingReleases}
          activeClass={inboxClass}
          onReload={reload}
          onLoadMore={() => loadMore('missing', view.counts.missingReleases)}
        />
        <MisalignedSection
          rows={view.misaligned}
          total={view.counts.misaligned}
          activeClass={inboxClass}
          onReload={reload}
          onLoadMore={() => loadMore('misaligned', view.counts.misaligned)}
        />
      </InboxStage>

      <InboxStage label="Anchor the tracks">
        <IsrcSection
          rows={view.isrcReleases}
          trackTotal={view.counts.isrc}
          releaseTotal={view.counts.isrcReleases}
          bot={bot}
          activeClass={inboxClass}
          onReload={reload}
          onBotChange={botChanged}
          onLoadMore={() => loadMore('isrcReleases', view.counts.isrcReleases)}
        />
        <BarcodesSection
          rows={view.barcodes}
          total={view.counts.barcodes}
          bot={bot}
          activeClass={inboxClass}
          onReload={reload}
          onBotChange={botChanged}
          onLoadMore={() => loadMore('barcodes', view.counts.barcodes)}
        />
      </InboxStage>

      <InboxStage label="Reach the work">
        <WorkRelationshipsSection
          rows={view.workGaps}
          total={view.counts.workRelationships}
          activeClass={inboxClass}
          onReload={reload}
          onLoadMore={() => loadMore('workGaps', view.counts.workRelationships)}
        />
      </InboxStage>

      <InboxStage label="Hygiene">
        <StreamingUrlsSection
          rows={view.streamingUrls}
          total={view.counts.streamingUrls}
          activeClass={inboxClass}
          onReload={reload}
          onLoadMore={() => loadMore('streamingUrls', view.counts.streamingUrls)}
        />
      </InboxStage>

      <InboxStage label="Upstream errors">
        <ContestedIsrcsSection
          rows={view.contested}
          total={view.counts.contestedIsrcs}
          activeClass={inboxClass}
          onReload={reload}
          onLoadMore={() => loadMore('contested', view.counts.contestedIsrcs)}
        />
      </InboxStage>

      <InboxStage label="Submitted">
        <SubmittedSection
          rows={view.recent}
          counts={view.counts.submissions}
          activeClass={inboxClass}
          onReload={reload}
        />
      </InboxStage>
    </div>
  );
}
