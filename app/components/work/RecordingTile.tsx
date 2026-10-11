import Link from 'next/link';
import type { ReactNode } from 'react';
import type { RecordingSummary } from '@/lib/library-types';
import { initialsOf, workHref } from '@/lib/prelude';
import { Icon } from '../Icon';
import { CoverArt } from './CoverArt';

/**
 * One recording of a work, linking to its page: a square tile in a grid
 * (the recording page's "other recordings"), or a row in a list (the
 * catalogue). A missing performer is said, not left blank; a recording
 * whose tracks aren't mapped says so instead of a duration.
 */
export function RecordingTile({
  workId,
  recording: r,
  layout,
  badge,
  liked = 0,
}: {
  workId: string;
  recording: RecordingSummary;
  layout: 'grid' | 'row';
  /** A label over the performer ("Your reference"). */
  badge?: ReactNode;
  /** How many of its movements the listener has saved. */
  liked?: number;
}) {
  const href = workHref({ workId, recordingId: r.recordingId });
  const performer = r.performer ?? (
    <span className="text-muted italic">performer not recorded</span>
  );
  const duration = r.unmatched ? 'tracks not mapped' : (r.duration ?? '—');

  if (layout === 'grid') {
    return (
      <Link href={href} className="group relative block text-left no-underline">
        <div className="relative mb-[9px] aspect-square overflow-hidden bg-paper-2 shadow-soft">
          <Cover
            recording={r}
            className="transition-transform duration-[600ms] ease-[cubic-bezier(.2,.7,.2,1)] group-hover:scale-[1.04]"
            initials="text-[28px]"
          />
        </div>
        {badge}
        <div className="font-display text-[16px] leading-[1.15] font-medium max-[900px]:text-[14px]">
          {performer}
        </div>
        {r.ensemble && (
          <div className="font-display text-[12.5px] leading-[1.25] text-ink-2 italic">
            {r.ensemble}
          </div>
        )}
        <div className="mt-1 font-meta text-[9.5px] tracking-[0.12em] text-muted uppercase">
          {[r.year, r.album].filter(Boolean).join(' · ')}
        </div>
        <div className="mt-px font-meta text-[10.5px] text-muted tabular-nums">{duration}</div>
      </Link>
    );
  }

  return (
    <Link
      href={href}
      className="group relative grid cursor-pointer grid-cols-[64px_1fr_auto] items-center gap-[18px] border-b border-rule px-[26px] py-[14px] no-underline hover:bg-paper-2 max-[900px]:grid-cols-[56px_1fr] max-[900px]:gap-x-[14px] max-[900px]:gap-y-2 max-[900px]:px-4 max-[900px]:py-3"
    >
      <span
        className="pointer-events-none absolute inset-y-0 left-0 w-[180px] opacity-[0.08] transition-opacity group-hover:opacity-[0.15] max-[900px]:w-[120px]"
        style={{ background: `linear-gradient(90deg, ${r.tint}, transparent)` }}
      />
      <span className="relative h-16 w-16 shrink-0 overflow-hidden shadow-soft max-[900px]:h-14 max-[900px]:w-14">
        <Cover
          recording={r}
          className="transition-transform duration-500 ease-[cubic-bezier(.2,.7,.2,1)] group-hover:scale-105"
          initials="bg-paper-2 text-[15px]"
        />
      </span>

      <span className="min-w-0">
        {badge}
        {r.unmatched && <Badge>tracks not mapped</Badge>}
        <span className="block truncate font-display text-[18px] leading-[1.15] font-medium">
          {performer}
        </span>
        {r.ensemble && (
          <span className="block truncate font-display text-[13.5px] text-ink-2 italic">
            {r.ensemble}
          </span>
        )}
        <span className="mt-1 flex flex-wrap items-baseline gap-x-[9px] gap-y-1 font-meta text-[9.5px] tracking-[0.12em] text-muted uppercase">
          <span className="truncate text-ink-2">{r.album}</span>
        </span>
      </span>

      <span className="flex flex-col items-end gap-[5px] whitespace-nowrap max-[900px]:col-start-2 max-[900px]:flex-row max-[900px]:items-baseline max-[900px]:justify-start max-[900px]:gap-3">
        {r.year && (
          <span className="onum font-display text-[19px] leading-none text-ink-2 max-[900px]:text-[15px]">
            {r.year}
          </span>
        )}
        <span className="font-meta text-[10.5px] text-muted tabular-nums">{r.duration ?? '—'}</span>
        {liked > 0 && (
          <span className="inline-flex items-center gap-1 font-meta text-[9.5px] tracking-[0.1em] text-accent">
            <Icon name="heartFill" size={9} />
            {liked} liked
          </span>
        )}
      </span>
    </Link>
  );
}

/** A small accent label above a recording's performer. */
export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="mb-[3px] block font-meta text-[8px] tracking-[0.2em] text-accent uppercase">
      {children}
    </span>
  );
}

function Cover({
  recording: r,
  className,
  initials,
}: {
  recording: RecordingSummary;
  className: string;
  initials: string;
}) {
  return (
    <>
      <CoverArt
        src={r.cover}
        alt={r.album}
        className={`block h-full w-full object-cover ${className}`}
      >
        <span
          className={`flex h-full w-full items-center justify-center font-display text-muted ${initials}`}
        >
          {initialsOf(r.performer ?? r.album)}
        </span>
      </CoverArt>
      <span className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)]" />
    </>
  );
}
