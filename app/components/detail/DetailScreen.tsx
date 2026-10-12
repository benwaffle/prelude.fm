'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePlayer, usePlayerActions } from '@/lib/spotify-player-context';
import { useLibrary } from '@/lib/library-context';
import { useServerQuery } from '@/lib/use-server-query';
import type { RecordingSummary, WorkSummary } from '@/lib/library-types';
import { getMusicBrainzWorkPage } from '@/app/actions/library-mb';
import {
  hexToRgba,
  initialsOf,
  queueFrom,
  withLiveLikes,
  workHref,
  type LibraryWork,
  type Movement,
} from '@/lib/prelude';
import { Icon } from '../Icon';
import { AddToQueueButton } from '../queue/AddToQueueButton';
import { LoadFailure } from '../LoadFailure';
import { CoverArt, WorkPlate } from '../work/CoverArt';
import { MovementList } from '../work/MovementList';
import { RecordingTile } from '../work/RecordingTile';
import { GapNotes, Missing, WorkTitle } from '../work/WorkText';

export function DetailScreen({
  workId,
  recordingId,
}: {
  workId: string;
  recordingId: string | null;
}) {
  const { likedTrackIds, rememberWork, toggleLike } = useLibrary();
  const { currentTrack } = usePlayer();
  const { play } = usePlayerActions();
  const page = useServerQuery(
    () => getMusicBrainzWorkPage(workId, recordingId),
    [workId, recordingId],
  );
  const detail = page.status === 'ready' ? page.data : null;

  useEffect(() => {
    if (detail) rememberWork(detail.work);
  }, [detail, rememberWork]);

  useEffect(() => {
    if (!detail) return;
    document.documentElement.style.setProperty('--room', hexToRgba(detail.work.tint, 0.5));
    return () => document.documentElement.style.setProperty('--room', 'transparent');
  }, [detail]);

  if (page.status === 'loading') {
    return (
      <main className="mx-auto max-w-[1280px] px-6 pt-16 pb-[180px] max-[900px]:px-4">
        <p className="font-display text-[15px] text-muted italic">Fetching the recording…</p>
      </main>
    );
  }

  if (page.status === 'error' || !detail) {
    return (
      <main className="mx-auto max-w-[1280px] px-6 pt-16 pb-[180px] max-[900px]:px-4">
        {page.status === 'error' ? (
          <LoadFailure what="this recording" error={page.message} onRetry={page.retry} />
        ) : (
          <p className="font-display text-[15px] text-muted italic">
            We hold no recording of that work.
          </p>
        )}
        <Link
          href="/catalog"
          className="mt-4 inline-flex items-center gap-[7px] font-meta text-[10px] tracking-[0.18em] text-muted uppercase no-underline hover:text-ink"
        >
          <Icon name="back" size={12} /> Browse the catalogue
        </Link>
      </main>
    );
  }

  const { work, others, moreByComposer } = detail;
  // The context knows the live liked set; trust it over the server snapshot.
  const movements = withLiveLikes(work.movements, likedTrackIds);

  const playFrom = (movement: Movement) => {
    const queue = queueFrom(movements, movement);
    if (queue.length > 0) play(queue);
  };

  return (
    <main className="relative z-[1] mx-auto max-w-[1280px] overflow-hidden px-6 pb-[180px] max-[900px]:px-4 max-[900px]:pb-[132px]">
      <Link
        href="/"
        className="mt-[22px] -mb-[6px] inline-flex items-center gap-[7px] font-meta text-[10px] tracking-[0.18em] text-muted uppercase no-underline transition-colors duration-150 hover:text-ink max-[900px]:mt-4 max-[900px]:-mb-1"
      >
        <span className="text-[13px] tracking-normal">←</span> Library
      </Link>

      <Hero
        work={{ ...work, movements }}
        imslpUrl={detail.imslpUrl}
        currentTrackId={currentTrack?.id ?? null}
        onPlay={playFrom}
        onToggleLike={toggleLike}
      />

      {others.length > 0 && <OtherRecordings workId={workId} others={others} />}

      {moreByComposer.length > 0 && work.composerFull && (
        <MoreByComposer
          key={work.id}
          composer={work.composerFull}
          works={moreByComposer}
          likedTrackIds={likedTrackIds}
        />
      )}
    </main>
  );
}

function Hero({
  work,
  imslpUrl,
  currentTrackId,
  onPlay,
  onToggleLike,
}: {
  work: LibraryWork;
  imslpUrl: string | null;
  currentTrackId: string | null;
  onPlay: (movement: Movement) => void;
  onToggleLike: (trackId: string) => void;
}) {
  return (
    <section className="relative grid animate-enter grid-cols-[320px_1fr] grid-rows-[auto_1fr] gap-x-12 gap-y-[34px] pt-12 pb-14 max-[900px]:grid-cols-[96px_minmax(0,1fr)] max-[900px]:gap-x-4 max-[900px]:gap-y-5 max-[900px]:pt-5 max-[900px]:pb-[30px]">
      <div className="relative row-span-2 aspect-square self-start shadow-deep max-[900px]:row-span-1">
        <CoverArt src={work.cover} alt={work.album} className="block h-full w-full object-cover">
          <WorkPlate work={work} size="hero" />
        </CoverArt>
        <span className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15),inset_0_0_40px_rgba(0,0,0,0.2)]" />
        <div className="absolute -bottom-[30px] left-0 font-display text-[14px] text-muted italic max-[900px]:hidden">
          — {work.album}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-[14px] max-[900px]:gap-[6px]">
        {work.era && (
          <div className="flex items-center gap-3 text-[10.5px] tracking-[0.22em] text-muted uppercase">
            <span className="h-px w-6 bg-muted" />
            <span className="text-ink-2">{work.era}</span>
          </div>
        )}

        <div className="mt-[2px] flex flex-wrap items-baseline gap-x-4 gap-y-1 max-[900px]:gap-x-2">
          <span className="font-display text-[32px] leading-none font-medium max-[900px]:text-[18px]">
            {work.composerFull ?? <Missing>composer</Missing>}
          </span>
          {work.years && (
            <span className="font-meta text-[12px] text-muted max-[900px]:text-[10.5px]">
              ({work.years})
            </span>
          )}
        </div>

        <h1 className="mt-[6px] mb-1 font-display text-[54px] leading-[1.02] font-medium text-balance max-[900px]:mt-0 max-[900px]:text-[clamp(22px,6.4vw,30px)]">
          <WorkTitle work={work} />
        </h1>

        <div className="font-display text-[14px] text-muted italic max-[900px]:text-[13px]">
          {work.performer}
          {work.ensemble && (
            <>
              <span className="mx-[10px] text-rule">·</span>
              {work.ensemble}
            </>
          )}
          {work.year && (
            <>
              <span className="mx-[10px] text-rule">·</span>
              composed {work.year}
            </>
          )}
        </div>

        <div className="truncate font-display text-[13px] text-muted italic min-[901px]:hidden">
          — {work.album}
        </div>

        <GapNotes work={work} />

        {work.catalog && (
          <div className="mt-[6px] inline-flex items-center gap-[10px] self-start rounded-[2px] border border-rule bg-paper-2 px-[14px] py-2">
            <span className="font-meta text-[9.5px] tracking-[0.2em] text-muted uppercase">
              Catalogue
            </span>
            <span className="font-display text-[16px]">{work.catalog}</span>
          </div>
        )}

        {imslpUrl && (
          <a
            href={imslpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="self-start font-meta text-[10px] tracking-[0.18em] text-muted uppercase no-underline transition-colors duration-150 hover:text-ink"
          >
            Score on IMSLP ↗
          </a>
        )}
      </div>

      <div className="flex min-w-0 flex-col max-[900px]:col-span-2">
        <div className="mb-3 flex items-baseline gap-5">
          <h2 className="m-0 font-meta text-[10.5px] font-semibold tracking-[0.22em] text-muted uppercase">
            Programme
          </h2>
          <AddToQueueButton work={work} className="-my-2 ml-auto py-2 text-muted hover:text-ink" />
        </div>
        {work.unmatched && (
          <p className="mb-3 border border-rule bg-paper-2 px-3 py-2 font-display text-[13px] text-muted italic">
            This recording’s tracks have not been mapped to movements yet.
          </p>
        )}
        <MovementList
          variant="programme"
          movements={work.movements}
          workTitle={work.title}
          playingTrackId={currentTrackId}
          onPlay={onPlay}
          onToggleLike={onToggleLike}
        />
      </div>
    </section>
  );
}

function OtherRecordings({ workId, others }: { workId: string; others: RecordingSummary[] }) {
  return (
    <section className="pt-[30px] pb-[6px] max-[900px]:pt-[22px] max-[900px]:pb-1">
      <div className="mb-6 flex items-center gap-[14px]">
        <span className="font-display text-2xl font-medium italic">
          Other recordings of this work
        </span>
        <span className="h-px flex-1 bg-rule" />
        <span className="font-meta text-[11px] tracking-[0.12em] text-muted uppercase">
          {others.length} alternative{others.length !== 1 ? 's' : ''}
          {others.every((r) => r.popularity === null) && (
            <span
              title="MusicBrainz recordings have no comparable popularity score"
              className="ml-2 text-accent"
            >
              · unranked
            </span>
          )}
        </span>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-[22px] pt-[18px] pb-1 max-[900px]:grid-cols-[repeat(auto-fill,minmax(118px,1fr))] max-[900px]:gap-[14px]">
        {others.map((r) => (
          <RecordingTile key={r.recordingId} workId={workId} recording={r} layout="grid" />
        ))}
      </div>
    </section>
  );
}

const MORE_BY_COMPOSER_SHOWN = 8;

function MoreByComposer({
  composer,
  works,
  likedTrackIds,
}: {
  composer: string;
  works: WorkSummary[];
  likedTrackIds: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  // Library works first; otherwise the server's order, which makes no claim to rank.
  const inLibrary = (w: WorkSummary) => w.trackIds.some((id) => likedTrackIds.has(id));
  const ordered = [...works.filter((w) => inLibrary(w)), ...works.filter((w) => !inLibrary(w))];
  const shown = expanded ? ordered : ordered.slice(0, MORE_BY_COMPOSER_SHOWN);

  return (
    <section className="pt-9">
      <div className="mb-6 flex items-center gap-[14px]">
        <span className="font-display text-2xl font-medium italic">More by {composer}</span>
        <span className="h-px flex-1 bg-rule" />
        <span className="font-meta text-[11px] tracking-[0.12em] text-muted uppercase">
          {works.length} work{works.length !== 1 ? 's' : ''}
        </span>
      </div>

      {shown.map((w, i) => (
        <Link
          key={w.workId}
          href={workHref(w)}
          className={`relative grid w-full grid-cols-[132px_1fr_240px] gap-7 border-b border-rule py-[26px] text-left no-underline hover:bg-[linear-gradient(90deg,var(--paper-2),transparent_60%)] max-[900px]:grid-cols-[84px_minmax(0,1fr)] max-[900px]:gap-[14px] ${
            i >= MORE_BY_COMPOSER_SHOWN ? 'animate-rise' : ''
          }`}
        >
          <div className="relative aspect-square self-start overflow-hidden bg-paper-2 shadow-soft">
            <CoverArt
              src={w.cover}
              alt={w.album ?? w.title ?? ''}
              className="block h-full w-full object-cover"
            >
              <span className="flex h-full w-full items-center justify-center font-display text-2xl text-muted">
                {initialsOf(composer)}
              </span>
            </CoverArt>
            <span className="onum pointer-events-none absolute -right-2 -bottom-2 font-display text-[48px] leading-none font-bold text-paper [-webkit-text-stroke:1px_var(--ink)]">
              {String(i + 1).padStart(2, '0')}
            </span>
          </div>

          <div className="flex min-w-0 flex-col gap-[6px] pt-1">
            <h3 className="m-0 font-display text-[28px] leading-[1.1] font-medium max-[900px]:text-[20px]">
              <WorkTitle work={w} />
            </h3>
            <div className="flex items-center gap-[10px] font-display text-[14px] text-muted italic">
              {w.catalog && (
                <span className="rounded-[1px] border border-rule bg-paper-2 px-[7px] py-[2px] font-meta text-[11px] tracking-[0.08em] text-ink-2 not-italic">
                  {w.catalog}
                </span>
              )}
              {w.year && <span>{w.year}</span>}
              <span className="text-rule">·</span>
              {w.unmatched ? (
                <span className="font-meta text-[10px] tracking-[0.16em] text-accent uppercase not-italic">
                  no tracks matched
                </span>
              ) : (
                <span>
                  {w.movementCount < w.partCount
                    ? `${w.movementCount} of ${w.partCount} movements`
                    : `${w.movementCount} movement${w.movementCount !== 1 ? 's' : ''}`}
                </span>
              )}
            </div>
            <div className="mt-2 text-[12.5px] text-ink-2">
              {w.unmatched ? (
                <span className="text-muted italic">
                  We hold a recording of this work but none of its tracks are mapped to movements
                  yet.
                </span>
              ) : (
                <>
                  {w.performer}
                  {w.ensemble && <span className="text-muted"> · {w.ensemble}</span>}
                </>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-col border-l border-rule pl-[18px] max-[900px]:hidden">
            <MovementList variant="summary" movements={w.movements} />
            {w.partCount > w.movements.length && (
              <div className="mt-[9px] font-meta text-[10px] tracking-[0.12em] text-muted uppercase">
                + {w.partCount - w.movements.length} more movements
              </div>
            )}
          </div>
        </Link>
      ))}

      {ordered.length > MORE_BY_COMPOSER_SHOWN && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="mt-5 cursor-pointer border-0 bg-transparent p-0 font-meta text-[10px] tracking-[0.18em] text-muted uppercase transition-colors duration-150 hover:text-ink"
        >
          {expanded ? 'Show fewer' : `Show all ${ordered.length} works`}
        </button>
      )}
    </section>
  );
}
