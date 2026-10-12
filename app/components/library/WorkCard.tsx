'use client';

import Link from 'next/link';
import { memo, useState, type ReactNode } from 'react';
import { Icon } from '../Icon';
import { workHref, type LibraryWork, type Movement } from '@/lib/prelude';
import { AddToQueueButton } from '../queue/AddToQueueButton';
import { CoverArt, WorkPlate } from '../work/CoverArt';
import { MovementList } from '../work/MovementList';
import { GapNotes, Missing, WorkTitle } from '../work/WorkText';

const CAP = 8;
const MORE =
  'mt-[9px] inline-block cursor-pointer self-start border-b border-transparent font-meta text-[9px] tracking-[0.16em] text-muted uppercase no-underline transition-colors duration-150 hover:border-muted';

interface WorkCardProps {
  work: LibraryWork;
  playingTrackId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPlayMovement: (work: LibraryWork, movement: Movement) => void;
  onPlayWork: (work: LibraryWork) => void;
  onToggleLike: (trackId: string) => void;
}

// Memoised: the library holds over a thousand cards and the player changes state several times a
// track.
export const WorkCard = memo(function WorkCard({
  work,
  playingTrackId,
  selectedId,
  onSelect,
  onPlayMovement,
  onPlayWork,
  onToggleLike,
}: WorkCardProps) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? work.movements : work.movements.slice(0, CAP);
  const extra = work.movements.length - shown.length;
  // An album card has no MusicBrainz work, so no page to open.
  const href = work.unmatched ? null : workHref(work);
  const linked = (className: string, children: ReactNode, label?: string) =>
    href ? (
      <Link prefetch={false} href={href} aria-label={label} className={className}>
        {children}
      </Link>
    ) : (
      <span className={className}>{children}</span>
    );
  const selectedPrefix = `${work.id}-`;
  const selectedN = selectedId?.startsWith(selectedPrefix)
    ? Number(selectedId.slice(selectedPrefix.length))
    : null;

  return (
    // content-visibility skips layout and paint off screen across 1000+ cards; the negative margin
    // keeps the colour bleed unclipped.
    <div className="-mx-6 px-6 [contain-intrinsic-size:auto_220px] [content-visibility:auto] max-[900px]:-mx-4 max-[900px]:px-4">
      <div className="group relative grid grid-cols-[132px_minmax(0,1fr)_300px] gap-[26px] border-b border-rule py-5 max-[900px]:grid-cols-[76px_minmax(0,1fr)] max-[900px]:gap-[14px] max-[900px]:pt-4 max-[900px]:pb-[14px]">
        <div
          className="pointer-events-none absolute inset-y-0 -left-6 w-[300px] opacity-[0.07] transition-opacity group-hover:opacity-[0.13] max-[900px]:-left-4 max-[900px]:w-[180px]"
          style={{ background: `linear-gradient(90deg, ${work.tint}, transparent)` }}
        />

        {linked(
          'relative block self-start no-underline',
          <span className="relative block aspect-square overflow-hidden shadow-soft">
            <CoverArt
              src={work.cover}
              alt={work.album}
              className="block h-full w-full object-cover transition-transform duration-[600ms] ease-[cubic-bezier(.2,.7,.2,1)] group-hover:scale-[1.03]"
            >
              <WorkPlate work={work} size="card" />
            </CoverArt>
            <span className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)]" />
          </span>,
          `${work.title ?? 'Untitled in MusicBrainz'} — recording detail`,
        )}

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
              className="flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center self-center rounded-full border max-[900px]:h-9 max-[900px]:w-9 border-rule text-muted transition duration-150 ease-out active:scale-95 group-hover:border-muted group-hover:text-ink-2 hover:border-ink hover:bg-ink hover:text-paper focus-visible:border-ink focus-visible:bg-ink focus-visible:text-paper"
            >
              <span className="ml-px">
                <Icon name="play" size={11} />
              </span>
            </button>
            {linked(
              'border-b border-transparent no-underline transition-colors duration-150 hover:border-rule',
              <WorkTitle work={work} />,
            )}
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

        <div className="flex min-w-0 flex-col border-l border-rule pl-[18px] max-[900px]:col-span-full max-[900px]:mt-1 max-[900px]:border-t max-[900px]:border-l-0 max-[900px]:pt-1 max-[900px]:pl-0">
          <MovementList
            variant="card"
            movements={shown}
            workTitle={work.title}
            sectionHeadings={work.unmatched}
            playingTrackId={playingTrackId}
            selectedN={selectedN}
            onSelect={(m) => onSelect(`${selectedPrefix}${m.n}`)}
            onPlay={(m) => onPlayMovement(work, m)}
            onToggleLike={onToggleLike}
          />
          {extra > 0 &&
            (href ? (
              <Link prefetch={false} href={href} className={MORE}>
                + {extra} more movement{extra !== 1 ? 's' : ''}
              </Link>
            ) : (
              <button type="button" onClick={() => setExpanded(true)} className={MORE}>
                + {extra} more track{extra !== 1 ? 's' : ''}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
});
