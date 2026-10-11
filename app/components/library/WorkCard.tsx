'use client';

import Link from 'next/link';
import { memo } from 'react';
import { Icon } from '../Icon';
import { workHref, type LibraryWork, type Movement } from '@/lib/prelude';
import { AddToQueueButton } from '../queue/AddToQueueButton';
import { CoverArt, WorkPlate } from '../work/CoverArt';
import { MovementList } from '../work/MovementList';
import { GapNotes, Missing, WorkTitle } from '../work/WorkText';

/** Movements beyond this fold behind a "+ n more" link into the detail view. */
const CAP = 8;

interface WorkCardProps {
  work: LibraryWork;
  playingTrackId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPlayMovement: (work: LibraryWork, movement: Movement) => void;
  onPlayWork: (work: LibraryWork) => void;
  onToggleLike: (trackId: string) => void;
}

/**
 * One library entry: cover, work, and the movement column where liking
 * actually happens. Single click selects a movement, double click plays it.
 *
 * Memoised: the library holds over a thousand of these, and the player
 * changes state several times a track.
 */
export const WorkCard = memo(function WorkCard({
  work,
  playingTrackId,
  selectedId,
  onSelect,
  onPlayMovement,
  onPlayWork,
  onToggleLike,
}: WorkCardProps) {
  const shown = work.movements.slice(0, CAP);
  const extra = work.movements.length - shown.length;
  const href = workHref(work);
  const selectedPrefix = `${work.id}-`;
  const selectedN = selectedId?.startsWith(selectedPrefix)
    ? Number(selectedId.slice(selectedPrefix.length))
    : null;

  return (
    /* Off screen, a card skips layout and paint until it scrolls near: the
       library runs to over a thousand cards, and without this every change
       anywhere on the page (the playing time, a scroll) redoes all of them.
       The wrapper reaches into the page margin so the colour bleed isn't
       clipped. */
    <div className="-mx-6 px-6 [contain-intrinsic-size:auto_220px] [content-visibility:auto] max-[900px]:-mx-4 max-[900px]:px-4">
      <div className="group relative grid grid-cols-[132px_minmax(0,1fr)_300px] gap-[26px] border-b border-rule py-5 max-[900px]:grid-cols-[76px_minmax(0,1fr)] max-[900px]:gap-[14px] max-[900px]:pt-4 max-[900px]:pb-[14px]">
        {/* The album's colour, bled in from the left margin. */}
        <div
          className="pointer-events-none absolute inset-y-0 -left-6 w-[300px] opacity-[0.07] transition-opacity group-hover:opacity-[0.13] max-[900px]:-left-4 max-[900px]:w-[180px]"
          style={{ background: `linear-gradient(90deg, ${work.tint}, transparent)` }}
        />

        <Link
          prefetch={false}
          href={href}
          aria-label={`${work.title ?? 'Untitled in MusicBrainz'} — recording detail`}
          className="relative block self-start no-underline"
        >
          <span className="relative block aspect-square overflow-hidden shadow-soft">
            <CoverArt
              src={work.cover}
              alt={work.album}
              className="block h-full w-full object-cover transition-transform duration-[600ms] ease-[cubic-bezier(.2,.7,.2,1)] group-hover:scale-[1.03]"
            >
              <WorkPlate work={work} size="card" />
            </CoverArt>
            <span className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)]" />
          </span>
        </Link>

        <div className="flex min-w-0 flex-col pt-[2px]">
          <div className="flex items-baseline gap-[9px] text-ink-2 max-[900px]:flex-wrap max-[900px]:gap-x-2 max-[900px]:gap-y-[3px]">
            {work.era && (
              <span className="font-meta text-[9px] tracking-[0.2em] text-muted uppercase">
                {work.era}
              </span>
            )}
            <Link
              prefetch={false}
              href="/catalog"
              className="border-b border-transparent font-display text-[15px] font-bold no-underline transition-colors duration-150 hover:border-muted"
            >
              {work.composer ?? <Missing>composer</Missing>}
            </Link>
            {work.years && <span className="font-meta text-[10px] text-muted">{work.years}</span>}
          </div>

          <h2 className="mt-1 flex items-baseline gap-[9px] font-display text-[26px] leading-[1.1] font-medium text-balance max-[900px]:text-[19px]">
            <button
              type="button"
              title={`Play ${work.title ?? 'this recording'}`}
              onClick={() => onPlayWork(work)}
              className="flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center self-center rounded-full border max-[900px]:h-9 max-[900px]:w-9 border-rule text-muted transition-colors duration-150 group-hover:border-muted group-hover:text-ink-2 hover:border-ink hover:bg-ink hover:text-paper focus-visible:border-ink focus-visible:bg-ink focus-visible:text-paper"
            >
              <span className="ml-px">
                <Icon name="play" size={11} />
              </span>
            </button>
            <Link
              prefetch={false}
              href={href}
              className="border-b border-transparent no-underline transition-colors duration-150 hover:border-rule"
            >
              <WorkTitle work={work} />
            </Link>
          </h2>

          <div className="mt-[6px] flex flex-wrap items-baseline gap-x-[9px] gap-y-1 font-display text-[13px] text-muted italic max-[900px]:text-[12px]">
            {work.catalog && (
              <Link
                prefetch={false}
                href="/catalog"
                className="border-b border-transparent font-meta text-[10px] tracking-[0.14em] text-ink-2 uppercase not-italic no-underline transition-colors duration-150 hover:border-muted"
              >
                {work.catalog}
              </Link>
            )}
            {work.year && <span>{work.year}</span>}
            <AddToQueueButton
              work={work}
              className="-my-2 py-2 text-muted not-italic hover:text-ink max-[900px]:text-[9.5px]"
            />
          </div>

          <GapNotes work={work} />

          <div className="mt-2 text-[12.5px] text-ink-2 max-[900px]:mt-[6px] max-[900px]:text-[12px]">
            <Link
              prefetch={false}
              href="/catalog"
              className="border-b border-transparent no-underline transition-colors duration-150 hover:border-muted"
            >
              {work.performer}
            </Link>
            {work.ensemble && (
              <>
                {' · '}
                <Link
                  prefetch={false}
                  href="/catalog"
                  className="border-b border-transparent text-muted italic no-underline transition-colors duration-150 hover:border-muted"
                >
                  {work.ensemble}
                </Link>
              </>
            )}
          </div>
        </div>

        {/* The left rule is the only line this column needs: the rows inside
          are set by rhythm, not ruled off one from the next. */}
        <div className="flex min-w-0 flex-col border-l border-rule pl-[18px] max-[900px]:col-span-full max-[900px]:mt-1 max-[900px]:border-t max-[900px]:border-l-0 max-[900px]:pt-1 max-[900px]:pl-0">
          <MovementList
            variant="card"
            movements={shown}
            workTitle={work.title}
            playingTrackId={playingTrackId}
            selectedN={selectedN}
            onSelect={(m) => onSelect(`${selectedPrefix}${m.n}`)}
            onPlay={(m) => onPlayMovement(work, m)}
            onToggleLike={onToggleLike}
          />
          {extra > 0 && (
            <Link
              prefetch={false}
              href={href}
              className="mt-[9px] inline-block self-start border-b border-transparent font-meta text-[9px] tracking-[0.16em] text-muted uppercase no-underline transition-colors duration-150 hover:border-muted"
            >
              + {extra} more movement{extra !== 1 ? 's' : ''}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
});
