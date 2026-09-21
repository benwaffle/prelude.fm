'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSpotifyPlayer } from '@/lib/spotify-player-context';
import { useLibrary } from '@/lib/library-context';
import {
  getWorkDetail,
  getWorkParent,
  type OtherRecording,
  type WorkDetail,
  type WorkParent,
  type WorkSummary,
} from '@/app/actions/library';
import {
  hexToRgba,
  initialsOf,
  numeralPrefix,
  queueFrom,
  type LibraryWork,
  type Movement,
} from '@/lib/prelude';
import { Icon, Waveform } from '../Icon';

/**
 * One recording in full: the art plate and its programme of movements, then
 * the other recordings of the same work, then more by the composer.
 */
export function DetailScreen({
  workId,
  recordingId,
}: {
  workId: number;
  recordingId: number | null;
}) {
  const { likedTrackIds, registerWorks, toggleLike } = useLibrary();
  const { currentTrack, play } = useSpotifyPlayer();
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [parent, setParent] = useState<WorkParent | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWorkParent(workId)
      .then((found) => {
        if (!cancelled) setParent(found);
      })
      .catch(() => {
        if (!cancelled) setParent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workId]);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    getWorkDetail(workId, recordingId, Array.from(likedTrackIds))
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setStatus('missing');
          return;
        }
        setDetail(result);
        setStatus('ready');
        // So the player bar can title what's playing while we're on this page.
        registerWorks([result.work]);
      })
      .catch((err) => {
        console.error('Failed to load recording:', err);
        if (!cancelled) setStatus('missing');
      });
    return () => {
      cancelled = true;
    };
    // Liked state is read once for the initial paint; hearts update locally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId, recordingId]);

  // The tinted wash behind the page takes its colour from this recording.
  useEffect(() => {
    if (!detail) return;
    document.documentElement.style.setProperty('--room', hexToRgba(detail.work.tint, 0.5));
    return () => document.documentElement.style.setProperty('--room', 'transparent');
  }, [detail]);

  if (status === 'loading') {
    return (
      <main className="mx-auto max-w-[1280px] px-6 pt-16 pb-[180px] max-[900px]:px-4">
        <p className="font-display text-[15px] text-muted italic">Fetching the recording…</p>
      </main>
    );
  }

  if (status === 'missing' || !detail) {
    return (
      <main className="mx-auto max-w-[1280px] px-6 pt-16 pb-[180px] max-[900px]:px-4">
        <p className="font-display text-[15px] text-muted italic">
          We hold no recording of that work.
        </p>
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
  const movements = work.movements.map((m) => ({
    ...m,
    liked: m.trackId !== null && likedTrackIds.has(m.trackId),
  }));

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
        currentTrackId={currentTrack?.id ?? null}
        onPlay={playFrom}
        onToggleLike={toggleLike}
      />

      {parent && <Collection parent={parent} />}

      {others.length > 0 && <OtherRecordings workId={workId} others={others} />}

      {moreByComposer.length > 0 && (
        <MoreByComposer composer={work.composerFull} works={moreByComposer} />
      )}
    </main>
  );
}

/**
 * The collection this work belongs to.
 *
 * Our own model is flat, so until MusicBrainz's tree was cached nothing could
 * say that a prelude and fugue is one of forty-eight. Parts MusicBrainz lists
 * that we hold nothing for are shown greyed rather than dropped: a book of
 * twenty-four showing twenty-three should look incomplete, not look like a
 * book of twenty-three.
 */
function Collection({ parent }: { parent: WorkParent }) {
  return (
    <section className="border-b border-rule pt-8 pb-7">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="m-0 font-display text-[17px] text-ink">{parent.title}</h2>
        <span className="font-meta text-[10px] tracking-[0.14em] text-muted uppercase">
          {parent.held} of {parent.siblings.length} here
        </span>
      </div>
      <ol className="m-0 grid list-none grid-cols-2 gap-x-8 gap-y-[2px] p-0 max-[900px]:grid-cols-1">
        {parent.siblings.map((sibling, index) => {
          const key = `${sibling.workId ?? 'absent'}-${sibling.ordering ?? index}`;
          const label = (
            <>
              <span className="w-6 shrink-0 text-right font-meta text-[10px] text-muted tabular-nums">
                {sibling.ordering ?? '·'}
              </span>
              <span className="truncate">{sibling.title}</span>
            </>
          );
          if (sibling.isCurrent) {
            return (
              <li key={key} className="flex items-baseline gap-3 py-[3px] text-[13px] text-ink">
                {label}
              </li>
            );
          }
          if (sibling.workId === null) {
            return (
              <li
                key={key}
                className="flex items-baseline gap-3 py-[3px] text-[13px] text-muted italic"
                title="Not in your library"
              >
                {label}
              </li>
            );
          }
          return (
            <li key={key} className="flex items-baseline gap-3 py-[3px] text-[13px]">
              <Link
                href={`/work/${sibling.workId}`}
                className="flex min-w-0 items-baseline gap-3 text-ink-2 no-underline transition-colors duration-150 hover:text-ink"
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Hero({
  work,
  currentTrackId,
  onPlay,
  onToggleLike,
}: {
  work: LibraryWork;
  currentTrackId: string | null;
  onPlay: (movement: Movement) => void;
  onToggleLike: (trackId: string) => void;
}) {
  return (
    <section className="relative grid grid-cols-[320px_1fr] gap-12 border-b border-rule pt-12 pb-14 max-[900px]:grid-cols-[minmax(0,1fr)] max-[900px]:gap-[22px] max-[900px]:pt-[26px] max-[900px]:pb-[30px]">
      <div className="relative aspect-square self-start shadow-deep max-[900px]:max-w-[260px]">
        <Plate work={work} />
        <span className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15),inset_0_0_40px_rgba(0,0,0,0.2)]" />
        <div className="absolute -bottom-[30px] left-0 font-display text-[14px] text-muted italic">
          — {work.album}
        </div>
      </div>

      <div className="flex flex-col gap-[14px]">
        {work.era && (
          <div className="flex items-center gap-3 text-[10.5px] tracking-[0.22em] text-muted uppercase">
            <span className="h-px w-6 bg-muted" />
            <span className="text-ink-2">{work.era}</span>
          </div>
        )}

        <div className="mt-[2px] flex items-baseline gap-4">
          <span className="font-display text-[32px] leading-none font-medium max-[900px]:text-2xl">
            {work.composerFull}
          </span>
          {work.years && <span className="font-meta text-[12px] text-muted">({work.years})</span>}
        </div>

        <h1 className="mt-[6px] mb-1 font-display text-[54px] leading-[1.02] font-medium text-balance max-[900px]:text-[clamp(28px,8vw,40px)]">
          {work.title}
          {work.nickname && (
            <>
              , <span className="text-accent italic">“{work.nickname}”</span>
            </>
          )}
        </h1>

        <div className="font-display text-[14px] text-muted italic">
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

        {work.catalog && (
          <div className="mt-[6px] inline-flex items-center gap-[10px] self-start rounded-[2px] border border-rule bg-paper-2 px-[14px] py-2">
            <span className="font-meta text-[9.5px] tracking-[0.2em] text-muted uppercase">
              Catalogue
            </span>
            <span className="font-display text-[16px]">{work.catalog}</span>
          </div>
        )}

        <div className="mt-5 flex flex-col">
          <h2 className="mb-3 font-meta text-[10.5px] font-semibold tracking-[0.22em] text-muted uppercase">
            Programme
          </h2>
          {work.unmatched && (
            <p className="mb-3 border border-rule bg-paper-2 px-3 py-2 font-display text-[13px] text-muted italic">
              This recording’s tracks have not been mapped to movements yet.
            </p>
          )}
          {/* Ruled top and bottom as one programme, not movement by
              movement — a rule per line buried the music in furniture. */}
          <ol className="m-0 flex list-none flex-col border-y border-rule p-0">
            {work.movements.map((m) => {
              const playing = m.trackId !== null && currentTrackId === m.trackId;

              /* A movement of the work that this recording doesn't carry.
                 Shown so the programme is the whole work, greyed out and
                 inert so it can't be mistaken for something playable. */
              if (m.missing) {
                return (
                  <li key={m.n} className="relative">
                    <div
                      title="This recording doesn't include this movement"
                      className="grid w-full grid-cols-[36px_1fr_auto_auto] items-baseline gap-4 py-[10px] text-left opacity-40 select-none"
                    >
                      <span className="onum text-right font-display text-[22px] text-muted italic">
                        {numeralPrefix(m.roman)}
                      </span>
                      <span className="font-display text-[20px] font-medium text-muted line-through decoration-rule">
                        {m.name}
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

              return (
                <li key={m.n} className="relative">
                  {playing && (
                    <span className="absolute top-1/2 -left-3 h-1 w-1 -translate-y-1/2 rounded-full bg-accent" />
                  )}
                  <div className="grid w-full grid-cols-[36px_1fr_auto_auto] items-baseline gap-4 py-[10px] text-left hover:bg-paper-2">
                    <button
                      type="button"
                      onClick={() => onPlay(m)}
                      className={`onum cursor-pointer text-right font-display text-[22px] ${
                        playing ? 'font-bold text-accent not-italic' : 'text-muted italic'
                      }`}
                    >
                      {numeralPrefix(m.roman)}
                    </button>
                    <button
                      type="button"
                      onClick={() => onPlay(m)}
                      className={`cursor-pointer text-left font-display text-[20px] font-medium ${
                        playing ? 'text-accent' : ''
                      }`}
                    >
                      {m.name}
                      {m.unnamed && (
                        <span
                          title="No movement metadata — showing the Spotify track title"
                          className="ml-[10px] align-middle font-meta text-[8px] tracking-[0.18em] text-muted uppercase"
                        >
                          unparsed
                        </span>
                      )}
                      {playing && <Waveform bars={5} className="ml-[10px] h-3 align-middle" />}
                    </button>
                    <span className="font-meta text-[12px] text-muted tabular-nums">
                      {m.duration}
                    </span>
                    <button
                      type="button"
                      title={m.liked ? 'Remove from liked' : 'Like this movement'}
                      onClick={() => m.trackId && onToggleLike(m.trackId)}
                      className={`flex cursor-pointer transition-all duration-150 hover:scale-110 ${
                        m.liked ? 'text-accent' : 'text-rule hover:text-muted'
                      }`}
                    >
                      <Icon name={m.liked ? 'heartFill' : 'heartOutline'} size={12} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}

function OtherRecordings({ workId, others }: { workId: number; others: OtherRecording[] }) {
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
              title="recording_v2.popularity is unpopulated, so these are in no meaningful order"
              className="ml-2 text-accent"
            >
              · unranked
            </span>
          )}
        </span>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-[22px] pt-[18px] pb-1 max-[900px]:grid-cols-[repeat(auto-fill,minmax(118px,1fr))] max-[900px]:gap-[14px]">
        {others.map((r) => (
          <Link
            key={r.recordingId}
            href={`/work/${workId}?rec=${r.recordingId}`}
            className="group relative block text-left no-underline"
          >
            <div className="relative mb-[9px] aspect-square overflow-hidden bg-paper-2 shadow-soft">
              {r.cover ? (
                // eslint-disable-next-line @next/next/no-img-element -- Spotify serves already-sized art
                <img
                  src={r.cover}
                  alt={r.album}
                  className="block h-full w-full object-cover transition-transform duration-[600ms] ease-[cubic-bezier(.2,.7,.2,1)] group-hover:scale-[1.04]"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center font-display text-[28px] text-muted">
                  {initialsOf(r.performer ?? r.album)}
                </span>
              )}
              <span className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)]" />
            </div>
            <div className="font-display text-[16px] leading-[1.15] font-medium max-[900px]:text-[14px]">
              {r.performer}
            </div>
            {r.ensemble && (
              <div className="font-display text-[12.5px] leading-[1.25] text-ink-2 italic">
                {r.ensemble}
              </div>
            )}
            <div className="mt-1 font-meta text-[9.5px] tracking-[0.12em] text-muted uppercase">
              {[r.year, r.album].filter(Boolean).join(' · ')}
            </div>
            <div className="mt-px font-meta text-[10.5px] text-muted tabular-nums">
              {r.unmatched ? 'tracks not mapped' : (r.duration ?? '—')}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

function MoreByComposer({ composer, works }: { composer: string; works: WorkSummary[] }) {
  return (
    <section className="pt-9">
      <div className="mb-6 flex items-center gap-[14px]">
        <span className="font-display text-2xl font-medium italic">More by {composer}</span>
        <span className="h-px flex-1 bg-rule" />
        <span className="font-meta text-[11px] tracking-[0.12em] text-muted uppercase">
          {works.length} work{works.length !== 1 ? 's' : ''}
        </span>
      </div>

      {works.map((w, i) => (
        <Link
          key={w.workId}
          href={`/work/${w.workId}?rec=${w.recordingId}`}
          className="relative grid w-full grid-cols-[132px_1fr_240px] gap-7 border-t border-rule py-[26px] text-left no-underline last:border-b hover:bg-[linear-gradient(90deg,var(--paper-2),transparent_60%)] max-[900px]:grid-cols-[84px_minmax(0,1fr)] max-[900px]:gap-[14px]"
        >
          <div className="relative aspect-square self-start overflow-hidden bg-paper-2 shadow-soft">
            {w.cover ? (
              // eslint-disable-next-line @next/next/no-img-element -- Spotify serves already-sized art
              <img
                src={w.cover}
                alt={w.album ?? w.title}
                className="block h-full w-full object-cover"
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center font-display text-2xl text-muted">
                {initialsOf(composer)}
              </span>
            )}
            <span className="onum pointer-events-none absolute -right-2 -bottom-2 font-display text-[48px] leading-none font-bold text-paper [-webkit-text-stroke:1px_var(--ink)]">
              {String(i + 1).padStart(2, '0')}
            </span>
          </div>

          <div className="flex min-w-0 flex-col gap-[6px] pt-1">
            <h3 className="m-0 font-display text-[28px] leading-[1.1] font-medium max-[900px]:text-[20px]">
              {w.title}
              {w.nickname && (
                <>
                  , <span className="text-accent italic">“{w.nickname}”</span>
                </>
              )}
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
            {w.movements.map((m, j) => (
              <div
                key={j}
                title={m.missing ? "This recording doesn't include this movement" : undefined}
                className={`grid grid-cols-[18px_1fr_auto] items-baseline gap-[10px] py-[3px] ${
                  m.missing ? 'opacity-40' : ''
                }`}
              >
                <span className="text-right font-display text-[12px] text-muted italic">
                  {numeralPrefix(m.roman)}
                </span>
                <span
                  className={`truncate font-display text-[13px] leading-[1.25] ${
                    m.missing ? 'text-muted line-through decoration-rule' : ''
                  }`}
                >
                  {m.name}
                </span>
                <span className="font-meta text-[10.5px] text-muted tabular-nums">
                  {m.duration ?? '—'}
                </span>
              </div>
            ))}
            {w.partCount > w.movements.length && (
              <div className="mt-[9px] font-meta text-[10px] tracking-[0.12em] text-muted uppercase">
                + {w.partCount - w.movements.length} more movements
              </div>
            )}
          </div>
        </Link>
      ))}
    </section>
  );
}

function Plate({ work }: { work: LibraryWork }) {
  const [failed, setFailed] = useState(false);
  if (failed || !work.cover) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-[6px] bg-paper-2 p-3 text-center"
        style={{ background: hexToRgba(work.tint, 0.16) }}
      >
        <span className="font-display text-[56px] leading-none font-medium text-ink-2">
          {initialsOf(work.composerFull)}
        </span>
        <span className="font-meta text-[10px] tracking-[0.18em] text-muted uppercase">
          {work.catalog ?? work.era ?? work.album}
        </span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Spotify serves already-sized art
    <img
      src={work.cover}
      alt={work.album}
      onError={() => setFailed(true)}
      className="block h-full w-full object-cover"
    />
  );
}
