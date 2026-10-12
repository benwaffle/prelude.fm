'use client';

import { Fragment, useRef } from 'react';
import { numeralPrefix, programmeMovementName, type Movement } from '@/lib/prelude';
import { Icon, Waveform } from '../Icon';
import { MovementName } from './WorkText';

// Every variant shows a movement the recording lacks as greyed, struck through and inert, so a
// partial recording reads as partial.
export type MovementListProps =
  | {
      variant: 'card';
      movements: Movement[];
      workTitle: string | null;
      /** Head each run of tracks with the section their titles shared (album cards). */
      sectionHeadings?: boolean;
      playingTrackId: string | null;
      selectedN: number | null;
      onSelect: (movement: Movement) => void;
      onPlay: (movement: Movement) => void;
      onToggleLike: (trackId: string) => void;
    }
  | {
      variant: 'programme';
      movements: Movement[];
      workTitle: string | null;
      playingTrackId: string | null;
      onPlay: (movement: Movement) => void;
      onToggleLike: (trackId: string) => void;
    }
  | {
      variant: 'summary';
      movements: Pick<Movement, 'roman' | 'name' | 'unnamed' | 'duration' | 'missing'>[];
    }
  | {
      variant: 'sheet';
      movements: Movement[];
      playingTrackId: string | null;
      isPaused: boolean;
      onPlay: (movement: Movement) => void;
    };

const NOT_ON_RECORDING = "This recording doesn't include this movement";

export function MovementList(props: MovementListProps) {
  switch (props.variant) {
    case 'card':
      return (
        <>
          {props.movements.map((m, i) => (
            <Fragment key={m.n}>
              {props.sectionHeadings &&
                m.section &&
                m.section !== props.movements[i - 1]?.section && (
                  <div className="truncate pt-[6px] pb-[1px] pl-[61px] font-display text-[13px] text-muted italic">
                    {m.section}
                  </div>
                )}
              <CardRow movement={m} list={props} />
            </Fragment>
          ))}
        </>
      );
    case 'programme':
      return (
        <ol className="m-0 flex list-none flex-col border-y border-rule p-0">
          {props.movements.map((m, i) => {
            const previous = props.movements[i - 1];
            // The section's own track ("V. Sanctus") already heads its sub-parts.
            const opensSection =
              m.section &&
              previous?.section !== m.section &&
              !(previous && !previous.section && previous.position === m.position);
            return (
              <Fragment key={m.n}>
                {opensSection && <SectionHeading movement={m} workTitle={props.workTitle} />}
                <ProgrammeRow movement={m} list={props} />
              </Fragment>
            );
          })}
        </ol>
      );
    case 'summary':
      return (
        <>
          {props.movements.map((m, i) => (
            <div
              key={i}
              title={m.missing ? NOT_ON_RECORDING : undefined}
              className={`grid grid-cols-[18px_1fr_auto] items-baseline gap-[10px] py-[3px] ${
                m.missing ? 'opacity-40' : ''
              }`}
            >
              <span className="text-right font-display text-[12px] text-muted italic">
                {numeralPrefix(m.roman)}
              </span>
              <span
                className={`flex min-w-0 items-baseline font-display text-[13px] leading-[1.25] ${
                  m.missing ? 'text-muted line-through decoration-rule' : ''
                }`}
              >
                <MovementName movement={m} className="truncate" />
              </span>
              <span className="font-meta text-[10.5px] text-muted tabular-nums">
                {m.duration ?? '—'}
              </span>
            </div>
          ))}
        </>
      );
    case 'sheet':
      return (
        <ol className="m-0 list-none border-t border-white/15 p-0">
          {props.movements.map((m) => {
            const current = m.trackId !== null && m.trackId === props.playingTrackId;
            return (
              <li key={m.n} className="border-b border-white/15">
                <button
                  type="button"
                  onClick={() => props.onPlay(m)}
                  className="grid w-full cursor-pointer grid-cols-[30px_minmax(0,1fr)_auto] items-baseline gap-3 py-3 text-left"
                >
                  <span className="text-right font-display text-[14px] italic opacity-70">
                    {numeralPrefix(m.roman)}
                  </span>
                  <span
                    className={`flex min-w-0 items-baseline gap-2 font-display text-[16px] ${current ? '' : 'opacity-80'}`}
                  >
                    <MovementName movement={m} className="truncate" />
                    {current && !props.isPaused && <Waveform />}
                  </span>
                  <span className="font-meta text-[11px] tabular-nums opacity-65">
                    {m.liked && <span className="mr-2">♥</span>}
                    {m.duration}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      );
  }
}

function LikeButton({
  movement,
  onToggleLike,
  size,
  className,
}: {
  movement: Movement;
  onToggleLike: (trackId: string) => void;
  size: number;
  className: string;
}) {
  return (
    <button
      type="button"
      title={movement.liked ? 'Remove from liked' : 'Like this movement'}
      onClick={(e) => {
        e.stopPropagation();
        if (movement.trackId) onToggleLike(movement.trackId);
      }}
      className={className}
    >
      <Icon name={movement.liked ? 'heartFill' : 'heartOutline'} size={size} />
    </button>
  );
}

function CardRow({
  movement,
  list,
}: {
  movement: Movement;
  list: Extract<MovementListProps, { variant: 'card' }>;
}) {
  const liked = movement.liked;
  const tappedRef = useRef(false);

  // A part of the work this recording lacks: shown so the programme reads whole, but inert.
  if (movement.missing) {
    return (
      <div
        title={NOT_ON_RECORDING}
        className="grid grid-cols-[15px_22px_minmax(0,1fr)_auto] items-baseline gap-3 py-[3px] pr-[2px] opacity-40 select-none"
      >
        <span aria-hidden />
        <span className="onum text-right font-display text-[13px] text-muted italic">
          {numeralPrefix(movement.roman)}
        </span>
        <div className="flex min-w-0 items-baseline font-display text-[14px] leading-[1.3] text-muted">
          <MovementName movement={movement} className="truncate line-through decoration-rule" />
        </div>
        <span className="font-meta text-[10.5px] text-muted tabular-nums">—</span>
        <span className="sr-only">{list.workTitle ?? 'This work'} — not on this recording</span>
      </div>
    );
  }

  const isPlaying = movement.trackId !== null && list.playingTrackId === movement.trackId;
  const play = () => list.onPlay(movement);
  return (
    <div
      role="button"
      tabIndex={0}
      title={`${movement.name} — double-click to play`}
      // A finger has no double-click worth asking for: a tap plays.
      onPointerDown={(e) => {
        tappedRef.current = e.pointerType !== 'mouse';
      }}
      onClick={() => (tappedRef.current ? play() : list.onSelect(movement))}
      onDoubleClick={play}
      onKeyDown={(e) => {
        if (e.key === 'Enter') play();
      }}
      className={`relative grid cursor-pointer grid-cols-[15px_22px_minmax(0,1fr)_auto] items-baseline gap-3 rounded-[2px] py-[3px] pr-[2px] select-none hover:bg-paper-2 max-[900px]:py-[9px] focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-ink-2 ${
        list.selectedN === movement.n ? 'bg-paper-3 shadow-[inset_0_0_0_1px_var(--rule)]' : ''
      }`}
    >
      {isPlaying && (
        <span className="absolute -left-[14px] top-1/2 h-[calc(100%-10px)] w-[2px] -translate-y-1/2 bg-accent" />
      )}
      <LikeButton
        movement={movement}
        onToggleLike={list.onToggleLike}
        size={11}
        className={`flex w-4 translate-y-px cursor-pointer items-center justify-start transition-all duration-150 before:absolute before:-inset-3 before:content-[''] relative ${
          liked
            ? 'text-accent hover:scale-110 active:scale-95'
            : 'text-rule group-hover:text-muted hover:text-muted active:scale-95'
        }`}
      />

      <span
        className={`onum text-right font-display text-[13px] ${
          liked ? 'font-bold text-accent not-italic' : 'text-muted italic opacity-55'
        }`}
      >
        {numeralPrefix(movement.roman)}
      </span>

      <div
        className={`flex min-w-0 items-baseline font-display text-[14px] leading-[1.3] ${
          isPlaying ? 'text-accent' : liked ? 'font-medium text-ink' : 'text-muted opacity-[0.62]'
        }`}
      >
        <MovementName movement={movement} className="truncate" />
        {isPlaying && (
          <span className="ml-[9px]">
            <Waveform />
          </span>
        )}
      </div>

      <span
        className={`font-meta text-[10.5px] tabular-nums ${
          liked ? 'text-ink-2' : 'text-muted opacity-55'
        }`}
      >
        {movement.duration}
      </span>
      <span className="sr-only">{list.workTitle ?? 'Untitled in MusicBrainz'}</span>
    </div>
  );
}

function SectionHeading({
  movement: m,
  workTitle,
}: {
  movement: Movement;
  workTitle: string | null;
}) {
  return (
    <li className="grid grid-cols-[36px_1fr] items-baseline gap-4 pt-[14px] pb-[2px]">
      <span className="onum text-right font-display text-[22px] text-muted italic">
        {numeralPrefix(m.roman)}
      </span>
      <span className="font-display text-[20px] font-medium">
        {programmeMovementName(m.section!, workTitle, m.roman)}
      </span>
    </li>
  );
}

function ProgrammeRow({
  movement: m,
  list,
}: {
  movement: Movement;
  list: Extract<MovementListProps, { variant: 'programme' }>;
}) {
  // A part of the work this recording lacks: shown, but inert so it can't be mistaken for playable.
  if (m.missing) {
    return (
      <li className="relative">
        <div
          title={NOT_ON_RECORDING}
          className="grid w-full grid-cols-[36px_1fr_auto_auto] items-baseline gap-4 py-[10px] text-left opacity-40 select-none"
        >
          <span className="onum text-right font-display text-[22px] text-muted italic">
            {numeralPrefix(m.roman)}
          </span>
          <span className="font-display text-[20px] font-medium text-muted">
            <MovementName
              movement={m}
              workTitle={list.workTitle}
              className="line-through decoration-rule"
            />
          </span>
          <span className="font-meta text-[12px] text-muted tabular-nums">—</span>
          <span
            aria-label="Not on this recording"
            className="font-meta text-[8px] tracking-[0.18em] text-muted uppercase"
          >
            not here
          </span>
        </div>
      </li>
    );
  }

  const playing = m.trackId !== null && list.playingTrackId === m.trackId;
  return (
    <li className="relative">
      {playing && (
        <span className="absolute top-1/2 -left-3 h-1 w-1 -translate-y-1/2 rounded-full bg-accent" />
      )}
      <div className="grid w-full grid-cols-[36px_1fr_auto_auto] items-baseline gap-4 py-[10px] text-left hover:bg-paper-2">
        <button
          type="button"
          onClick={() => list.onPlay(m)}
          className={`onum cursor-pointer text-right font-display text-[22px] ${
            playing ? 'font-bold text-accent not-italic' : 'text-muted italic'
          }`}
        >
          {m.section ? '' : numeralPrefix(m.roman)}
        </button>
        <button
          type="button"
          onClick={() => list.onPlay(m)}
          className={`cursor-pointer text-left font-display text-[20px] font-medium ${
            playing ? 'text-accent' : ''
          } ${m.section ? 'pl-5' : ''}`}
        >
          <MovementName movement={m} workTitle={m.section ?? list.workTitle} />
          {playing && <Waveform bars={5} className="ml-[10px] h-3 align-middle" />}
        </button>
        <span className="font-meta text-[12px] text-muted tabular-nums">{m.duration}</span>
        <LikeButton
          movement={m}
          onToggleLike={list.onToggleLike}
          size={12}
          className={`flex cursor-pointer transition-all duration-150 hover:scale-110 active:scale-95 ${
            m.liked ? 'text-accent' : 'text-rule hover:text-muted'
          }`}
        />
      </div>
    </li>
  );
}
