'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Icon, Waveform } from '../Icon';
import { initialsOf, numeralPrefix, type LibraryWork, type Movement } from '@/lib/prelude';
import type { MusicBrainzGapCode } from '@/lib/musicbrainz-library';

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
 */
export function WorkCard({
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
  const href = `/work/${work.workId}?rec=${work.recordingId}`;

  return (
    <div className="group relative grid grid-cols-[132px_minmax(0,1fr)_300px] gap-[26px] border-b border-rule py-5 max-[900px]:grid-cols-[76px_minmax(0,1fr)] max-[900px]:gap-[14px] max-[900px]:pt-4 max-[900px]:pb-[14px]">
      {/* The album's colour, bled in from the left margin. */}
      <div
        className="pointer-events-none absolute inset-y-0 -left-6 w-[300px] opacity-[0.07] transition-opacity group-hover:opacity-[0.13] max-[900px]:-left-4 max-[900px]:w-[180px]"
        style={{ background: `linear-gradient(90deg, ${work.tint}, transparent)` }}
      />

      <Link
        href={href}
        aria-label={`${work.title ?? 'Untitled in MusicBrainz'} — recording detail`}
        className="relative block self-start no-underline"
      >
        <span className="relative block aspect-square overflow-hidden shadow-soft">
          <CoverArt work={work} />
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
            className="flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center self-center rounded-full border border-rule text-muted transition-colors duration-150 group-hover:border-muted group-hover:text-ink-2 hover:border-ink hover:bg-ink hover:text-paper focus-visible:border-ink focus-visible:bg-ink focus-visible:text-paper"
          >
            <span className="ml-px">
              <Icon name="play" size={11} />
            </span>
          </button>
          <Link
            href={href}
            className="border-b border-transparent no-underline transition-colors duration-150 hover:border-rule"
          >
            {work.title ?? <Missing>title</Missing>}
            {work.nickname && (
              <>
                , <span className="text-accent italic">“{work.nickname}”</span>
              </>
            )}
          </Link>
        </h2>

        <div className="mt-[6px] flex flex-wrap items-baseline gap-x-[9px] gap-y-1 font-display text-[13px] text-muted italic max-[900px]:text-[12px]">
          {work.catalog && (
            <Link
              href="/catalog"
              className="border-b border-transparent font-meta text-[10px] tracking-[0.14em] text-ink-2 uppercase not-italic no-underline transition-colors duration-150 hover:border-muted"
            >
              {work.catalog}
            </Link>
          )}
          {work.year && <span>{work.year}</span>}
        </div>

        <Gaps codes={work.gaps} />

        <div className="mt-2 text-[12.5px] text-ink-2 max-[900px]:mt-[6px] max-[900px]:text-[12px]">
          <Link
            href="/catalog"
            className="border-b border-transparent no-underline transition-colors duration-150 hover:border-muted"
          >
            {work.performer}
          </Link>
          {work.ensemble && (
            <>
              {' · '}
              <Link
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
        {shown.map((m) => (
          <MovementRow
            key={m.n}
            work={work}
            movement={m}
            isPlaying={m.trackId !== null && playingTrackId === m.trackId}
            isSelected={selectedId === `${work.id}-${m.n}`}
            onSelect={() => onSelect(`${work.id}-${m.n}`)}
            onPlay={() => onPlayMovement(work, m)}
            onToggleLike={() => m.trackId && onToggleLike(m.trackId)}
          />
        ))}
        {extra > 0 && (
          <Link
            href={href}
            className="mt-[9px] inline-block self-start border-b border-transparent font-meta text-[9px] tracking-[0.16em] text-muted uppercase no-underline transition-colors duration-150 hover:border-muted"
          >
            + {extra} more movement{extra !== 1 ? 's' : ''}
          </Link>
        )}
      </div>
    </div>
  );
}

function MovementRow({
  work,
  movement,
  isPlaying,
  isSelected,
  onSelect,
  onPlay,
  onToggleLike,
}: {
  work: LibraryWork;
  movement: Movement;
  isPlaying: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onPlay: () => void;
  onToggleLike: () => void;
}) {
  const liked = movement.liked;

  // A part of the work this recording doesn't carry: present so the programme
  // reads whole, but greyed out and inert — nothing to play, nothing to like.
  if (movement.missing) {
    return (
      <div
        title="This recording doesn't include this movement"
        className="grid grid-cols-[15px_22px_minmax(0,1fr)_auto] items-baseline gap-3 py-[3px] pr-[2px] opacity-40 select-none"
      >
        <span aria-hidden />
        <span className="onum text-right font-display text-[13px] text-muted italic">
          {numeralPrefix(movement.roman)}
        </span>
        <div className="flex min-w-0 items-baseline gap-[9px] font-display text-[14px] leading-[1.3] text-muted">
          <span className="truncate line-through decoration-rule">{movement.name}</span>
        </div>
        <span className="font-meta text-[10.5px] text-muted tabular-nums">—</span>
        <span className="sr-only">{work.title ?? 'This work'} — not on this recording</span>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      title={`${movement.name} — double-click to play`}
      onClick={onSelect}
      onDoubleClick={onPlay}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onPlay();
      }}
      className={`relative grid cursor-pointer grid-cols-[15px_22px_minmax(0,1fr)_auto] items-baseline gap-3 rounded-[2px] py-[3px] pr-[2px] hover:bg-paper-2 focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-ink-2 ${
        isSelected ? 'bg-paper-3 shadow-[inset_0_0_0_1px_var(--rule)]' : ''
      }`}
    >
      {isPlaying && (
        <span className="absolute -left-[14px] top-1/2 h-[calc(100%-10px)] w-[2px] -translate-y-1/2 bg-accent" />
      )}
      <button
        type="button"
        title={liked ? 'Remove from liked' : 'Like this movement'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleLike();
        }}
        className={`flex w-4 translate-y-px cursor-pointer items-center justify-start transition-all duration-150 ${
          liked
            ? 'text-accent hover:scale-110'
            : 'text-rule group-hover:text-muted hover:text-muted'
        }`}
      >
        <Icon name={liked ? 'heartFill' : 'heartOutline'} size={11} />
      </button>

      <span
        className={`onum text-right font-display text-[13px] ${
          liked ? 'font-bold text-accent not-italic' : 'text-muted italic opacity-55'
        }`}
      >
        {numeralPrefix(movement.roman)}
      </span>

      <div
        className={`flex min-w-0 items-baseline gap-[9px] font-display text-[14px] leading-[1.3] ${
          isPlaying ? 'text-accent' : liked ? 'font-medium text-ink' : 'text-muted opacity-[0.62]'
        }`}
      >
        <span className="truncate">{movement.name}</span>
        {movement.unnamed && (
          <span
            title="No movement metadata — showing the Spotify track title"
            className="shrink-0 font-meta text-[8px] tracking-[0.18em] text-muted uppercase not-italic"
          >
            unparsed
          </span>
        )}
        {isPlaying && <Waveform />}
      </div>

      <span
        className={`font-meta text-[10.5px] tabular-nums ${
          liked ? 'text-ink-2' : 'text-muted opacity-55'
        }`}
      >
        {movement.duration}
      </span>
      <span className="sr-only">{work.title ?? 'Untitled in MusicBrainz'}</span>
    </div>
  );
}

/** Album art, falling back to a typographic plate when the image fails. */
function CoverArt({ work }: { work: LibraryWork }) {
  const [failed, setFailed] = useState(false);

  if (failed || !work.cover) {
    return (
      <span
        className="absolute inset-0 flex flex-col items-center justify-center gap-[6px] bg-paper-2 p-3 text-center"
        style={{ ['--tint' as string]: work.tint }}
      >
        <span
          className="absolute inset-0 opacity-[0.16]"
          style={{ background: work.tint }}
          aria-hidden
        />
        {work.composerFull && (
          <span className="relative font-display text-[40px] leading-none font-medium text-ink-2 max-[900px]:text-[26px]">
            {initialsOf(work.composerFull)}
          </span>
        )}
        <span className="relative font-meta text-[9px] tracking-[0.18em] text-muted uppercase max-[900px]:text-[7.5px]">
          {work.catalog ?? work.era ?? work.album}
        </span>
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- Spotify serves already-sized art
    <img
      src={work.cover}
      alt={work.album}
      onError={() => setFailed(true)}
      className="block h-full w-full object-cover transition-transform duration-[600ms] ease-[cubic-bezier(.2,.7,.2,1)] group-hover:scale-[1.03]"
    />
  );
}

/**
 * A field MusicBrainz has not filled. Shown rather than left blank, because
 * a blank reads as "nothing to say" and this is "nobody has said it yet" —
 * the difference is the whole point of the gap vocabulary.
 */
function Missing({ children }: { children: ReactNode }) {
  return (
    <span className="font-meta text-[0.62em] tracking-[0.14em] text-muted uppercase italic">
      no {children} in MusicBrainz
    </span>
  );
}

/** What this card cannot show, listed plainly under it. */
function Gaps({ codes }: { codes: MusicBrainzGapCode[] }) {
  if (codes.length === 0) return null;
  return (
    <p className="mt-[6px] font-meta text-[10px] tracking-[0.12em] text-muted uppercase">
      Incomplete in MusicBrainz: {codes.join(', ')}
    </p>
  );
}
