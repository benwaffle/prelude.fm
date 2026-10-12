import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  programmeMovementName,
  unnamedMovementNote,
  type LibraryWork,
  type Movement,
} from '@/lib/prelude';
import { GAP_REASONS } from '@/lib/gap-reasons';
import type { MusicBrainzGapCode } from '@/lib/musicbrainz-library';

// A field MusicBrainz has not filled: labelled, because a blank reads as "nothing to say" rather
// than "nobody has said it yet".
export function Missing({
  children,
  className = 'text-muted',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`font-meta text-[0.62em] tracking-[0.14em] uppercase italic ${className}`}>
      no {children} in MusicBrainz
    </span>
  );
}

export function WorkTitle({ work }: { work: Pick<LibraryWork, 'title' | 'nickname'> }) {
  return (
    <>
      {work.title ?? <Missing>title</Missing>}
      {work.nickname && (
        <>
          , <span className="text-accent italic">“{work.nickname}”</span>
        </>
      )}
    </>
  );
}

export function MovementName({
  movement,
  workTitle,
  className,
}: {
  movement: Pick<Movement, 'name' | 'unnamed' | 'roman'>;
  workTitle?: string | null;
  className?: string;
}) {
  const name =
    workTitle === undefined
      ? movement.name
      : programmeMovementName(movement.name, workTitle, movement.roman);
  return (
    <>
      <span className={className}>{name}</span>
      {movement.unnamed && (
        <span
          title={unnamedMovementNote(movement)}
          className="ml-[9px] shrink-0 align-middle font-meta text-[8px] tracking-[0.18em] uppercase not-italic opacity-70"
        >
          unparsed
        </span>
      )}
    </>
  );
}

export function GapNotes({ work }: { work: Pick<LibraryWork, 'gaps' | 'ownLink' | 'unmatched'> }) {
  return (
    <>
      {work.unmatched && (
        <p className="mt-[6px] font-meta text-[10px] tracking-[0.12em] text-accent uppercase">
          Spotify album, not on MusicBrainz yet
        </p>
      )}
      {work.ownLink && (
        <p className="mt-[6px] font-meta text-[10px] tracking-[0.12em] text-accent uppercase">
          Work matched by prelude.fm, not MusicBrainz ({work.ownLink} confidence)
        </p>
      )}
      <Gaps codes={work.gaps} />
    </>
  );
}

function Gaps({ codes }: { codes: MusicBrainzGapCode[] }) {
  if (codes.length === 0) return null;
  return (
    <p
      title={codes.join(', ')}
      className="mt-[6px] font-display text-[13px] leading-snug text-muted italic max-[900px]:text-[12.5px]"
    >
      <span className="mr-[6px] font-meta text-[9px] tracking-[0.16em] uppercase not-italic">
        Gaps
      </span>
      {codes.map((code) => GAP_REASONS[code]).join(' · ')}
    </p>
  );
}

export function WorkCredit({
  work,
  href,
  onNavigate,
}: {
  work: Pick<LibraryWork, 'composerFull' | 'title' | 'nickname'>;
  href?: string;
  onNavigate?: () => void;
}) {
  const title = work.title ?? <Missing className="">title</Missing>;
  return (
    <>
      {work.composerFull ?? <Missing className="">composer</Missing>}
      {' · '}
      {href ? (
        <Link
          href={href}
          onClick={onNavigate}
          className="border-b border-transparent no-underline transition-colors duration-150 hover:border-current"
        >
          <i>{title}</i>
        </Link>
      ) : (
        <i>{title}</i>
      )}
      {work.nickname && <> “{work.nickname}”</>}
    </>
  );
}
