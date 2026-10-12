'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePlayer, usePlayerActions } from '@/lib/spotify-player-context';
import { LoadFailure } from '../LoadFailure';
import { useLibrary } from '@/lib/library-context';
import { useNavSearch } from '../AppShell';
import { ERAS, playable, queueFrom, type LibraryWork, type Movement } from '@/lib/prelude';
import { Icon } from '../Icon';
import { WorkCard } from './WorkCard';
import { ComposerStrip } from './ComposerStrip';
import { GapStrip } from './GapStrip';

type Sort = 'added' | 'composer' | 'era';

const SORTS: [Sort, string][] = [
  ['added', 'Recently liked'],
  ['composer', 'Composer'],
  ['era', 'Era'],
];

export function LibraryScreen() {
  const { works, gapTracks, loading, refreshing, matching, error, matchFailure, toggleLike } =
    useLibrary();
  const { currentTrack } = usePlayer();
  const { play } = usePlayerActions();
  const { query, setQuery } = useNavSearch();
  const [sort, setSort] = useState<Sort>('added');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const likedWorks = useMemo(() => {
    let list = works.filter((w) => w.movements.some((m) => m.liked));

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (w) =>
          (w.composerFull ?? '').toLowerCase().includes(q) ||
          (w.title ?? '').toLowerCase().includes(q) ||
          (w.nickname ?? '').toLowerCase().includes(q) ||
          (w.catalog ?? '').toLowerCase().includes(q) ||
          (w.performer ?? '').toLowerCase().includes(q),
      );
    }

    if (sort === 'composer') {
      return [...list].sort(
        (a, b) =>
          (a.composerFull ?? '').localeCompare(b.composerFull ?? '', 'en') ||
          (a.title ?? '').localeCompare(b.title ?? '', 'en'),
      );
    }
    if (sort === 'era') {
      // Composers with unknown dates sort last rather than masquerading as the most recent.
      const rank = (w: LibraryWork) => (w.era === null ? ERAS.length : ERAS.indexOf(w.era));
      return [...list].sort(
        (a, b) =>
          rank(a) - rank(b) || (a.composerFull ?? '').localeCompare(b.composerFull ?? '', 'en'),
      );
    }
    return [...list].sort((a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''));
  }, [works, query, sort]);

  const groups = useMemo(() => {
    if (sort === 'added') return [{ key: null as string | null, works: likedWorks }];
    const by = new Map<string, LibraryWork[]>();
    for (const w of likedWorks) {
      const key =
        sort === 'composer' ? (w.composerFull ?? 'Composer unknown') : (w.era ?? 'Era unknown');
      const bucket = by.get(key);
      if (bucket) bucket.push(w);
      else by.set(key, [w]);
    }
    return Array.from(by, ([key, group]) => ({ key, works: group }));
  }, [likedWorks, sort]);

  const playFrom = useCallback(
    (work: LibraryWork, movement: Movement) => {
      const queue = queueFrom(work.movements, movement);
      if (queue.length > 0) play(queue);
    },
    [play],
  );

  const playWork = useCallback(
    (work: LibraryWork) => {
      const here = playable(work.movements);
      const first = here.find((m) => m.liked) ?? here[0];
      if (first) playFrom(work, first);
    },
    [playFrom],
  );

  const playingTrackId = currentTrack?.id ?? null;

  const playAll = () => {
    const first = likedWorks[0];
    if (!first) return;
    playWork(first);
  };

  return (
    // overflow-x-clip, not overflow-hidden: it contains the gradient bleed without becoming a
    // scroll container, so the sticky headings still stick.
    <main className="relative z-[1] mx-auto max-w-[1280px] overflow-x-clip px-6 pb-[180px] max-[900px]:px-4 max-[900px]:pb-[132px]">
      <Masthead works={likedWorks} loading={loading || matching} refreshing={refreshing} />

      <Toolbar
        sort={sort}
        setSort={setSort}
        onPlayAll={playAll}
        disabled={likedWorks.length === 0}
      />

      {groups.length > 1 && <GroupIndex groups={groups} />}

      {error && (
        <p className="py-10 font-display text-[15px] text-accent italic">
          Spotify wouldn’t hand over your library: {error}
        </p>
      )}

      {!error && matchFailure && (
        <LoadFailure
          className="py-10 font-display text-[15px] text-accent italic"
          what="the works your liked songs belong to"
          error={matchFailure.message}
          onRetry={matchFailure.retry}
        />
      )}

      {!error && !matchFailure && likedWorks.length === 0 && (
        <p className="py-16 font-display text-[15px] text-muted italic">
          {loading || matching
            ? 'Reading your liked songs…'
            : query.trim()
              ? `Nothing in your library matches “${query.trim()}”.`
              : 'Nothing here yet. Like a movement on Spotify and it will appear.'}
        </p>
      )}

      {groups.map((group) => (
        <section
          key={group.key ?? 'all'}
          id={group.key ? `g-${slug(group.key)}` : undefined}
          className="scroll-mt-[70px] [&+&]:mt-[6px]"
        >
          {group.key && (
            <div className="sticky top-[var(--nav-h)] z-[5] flex items-baseline gap-3 border-b border-transparent bg-paper pt-[26px] pb-[6px] max-[900px]:pt-5 max-[900px]:pb-1">
              <span className="font-display text-[22px] font-medium whitespace-nowrap max-[900px]:text-[18px]">
                {group.key}
              </span>
              <span className="h-px flex-1 self-center bg-rule" />
              <span className="font-meta text-[9.5px] tracking-[0.18em] whitespace-nowrap text-muted uppercase">
                {group.works.length} work{group.works.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}
          {group.works.map((w) => (
            <WorkCard
              key={w.id}
              work={w}
              playingTrackId={holds(w, playingTrackId) ? playingTrackId : null}
              selectedId={
                w.movements.some((m) => `${w.id}-${m.n}` === selectedId) ? selectedId : null
              }
              onSelect={setSelectedId}
              onPlayMovement={playFrom}
              onPlayWork={playWork}
              onToggleLike={toggleLike}
            />
          ))}
        </section>
      ))}

      <ComposerStrip works={likedWorks} onPick={setQuery} />
      {/* Until the works resolve every track looks unmatched; don't claim the library is
          unidentifiable meanwhile. */}
      {!loading && !matching && <GapStrip tracks={gapTracks} />}
    </main>
  );
}

function holds(work: LibraryWork, trackId: string | null): boolean {
  return trackId !== null && work.movements.some((m) => m.trackId === trackId);
}

function slug(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '');
}

function Masthead({
  works,
  loading,
  refreshing,
}: {
  works: LibraryWork[];
  loading: boolean;
  refreshing: boolean;
}) {
  const likedCount = works.reduce((a, w) => a + w.movements.filter((m) => m.liked).length, 0);
  const totalMs = works.reduce(
    (a, w) => a + w.movements.reduce((b, m) => b + (m.liked ? (m.durationMs ?? 0) : 0), 0),
    0,
  );
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.round((totalMs % 3_600_000) / 60_000);
  const composers = new Set(works.map((w) => w.composerFull)).size;

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-6 pt-[26px] pb-1 max-[900px]:pt-3 max-[900px]:pb-0">
      <div className="flex items-center gap-3 text-muted max-[900px]:hidden">
        <span className="text-[10.5px] font-semibold tracking-[0.18em] uppercase">
          Your library
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline gap-2 font-display text-[15px] text-muted italic">
        {loading && works.length === 0 ? (
          <span>gathering…</span>
        ) : (
          <>
            <Tally value={likedCount} unit="movements" />
            <span className="text-rule">·</span>
            <Tally value={works.length} unit="works" />
            <span className="text-rule">·</span>
            <Tally value={composers} unit="composers" />
            <span className="text-rule">·</span>
            <b className="onum font-semibold whitespace-nowrap text-ink not-italic">
              {hours}h {minutes}m
            </b>
            {/* The counts are stale until the refresh lands; say so. */}
            {refreshing && (
              <>
                <span className="text-rule">·</span>
                <span className="whitespace-nowrap">re-reading Spotify…</span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Tally({ value, unit }: { value: number; unit: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <b className="onum font-semibold whitespace-nowrap text-ink not-italic">{value}</b> {unit}
    </span>
  );
}

function Toolbar({
  sort,
  setSort,
  onPlayAll,
  disabled,
}: {
  sort: Sort;
  setSort: (s: Sort) => void;
  onPlayAll: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-rule py-[14px] max-[900px]:flex-wrap max-[900px]:gap-2 max-[900px]:py-3">
      <button
        type="button"
        onClick={onPlayAll}
        disabled={disabled}
        className="inline-flex cursor-pointer items-center gap-[9px] rounded-[2px] bg-ink py-[9px] pr-[15px] pl-[13px] font-meta text-[10px] tracking-[0.18em] text-paper uppercase hover:bg-accent disabled:cursor-default disabled:opacity-40"
      >
        <Icon name="play" size={12} />
        Play all
      </button>

      <div className="ml-auto flex flex-wrap items-center gap-[10px] max-[900px]:ml-0 max-[900px]:w-full">
        <span className="font-meta text-[9px] tracking-[0.2em] text-muted uppercase max-[900px]:hidden">
          Sort
        </span>
        <div className="no-bar flex gap-[2px] max-[900px]:order-3 max-[900px]:w-full max-[900px]:overflow-x-auto max-[900px]:pt-[6px]">
          {SORTS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              className={`cursor-pointer border-b px-3 py-[7px] font-meta text-[10px] tracking-[0.16em] whitespace-nowrap uppercase transition-colors duration-150 ${
                sort === key
                  ? 'border-accent text-ink'
                  : 'border-transparent text-muted hover:text-ink-2'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function GroupIndex({ groups }: { groups: { key: string | null; works: LibraryWork[] }[] }) {
  const jump = (key: string) => {
    const el = document.getElementById(`g-${slug(key)}`);
    if (!el) return;
    const nav = document.querySelector('.sticky');
    const top =
      el.getBoundingClientRect().top +
      window.scrollY -
      ((nav instanceof HTMLElement ? nav.offsetHeight : 0) + 12);
    window.scrollTo({ top, behavior: 'smooth' });
  };

  return (
    <nav className="no-bar flex flex-wrap gap-[6px] pt-[14px] pb-1 max-[900px]:flex-nowrap max-[900px]:overflow-x-auto max-[900px]:pt-[10px]">
      {groups.map((g) =>
        g.key ? (
          <button
            key={g.key}
            type="button"
            onClick={() => jump(g.key!)}
            className="inline-flex shrink-0 cursor-pointer items-baseline gap-[6px] rounded-[2px] border border-rule px-[10px] py-[5px] font-display text-[13px] whitespace-nowrap text-ink-2 transition-colors duration-150 hover:border-ink-2 hover:bg-paper-2 hover:text-ink"
          >
            {g.key}
            <span className="font-meta text-[9px] text-muted tabular-nums">{g.works.length}</span>
          </button>
        ) : null,
      )}
    </nav>
  );
}
