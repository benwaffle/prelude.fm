'use client';

import Link from 'next/link';
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  getCatalogComposers,
  getCatalogRecordings,
  getCatalogWorkHeader,
  getCatalogWorks,
  type CatalogComposer,
  type CatalogRecording,
  type CatalogWork,
} from '@/app/actions/library';
import { searchWorks, type WorkSearchHit } from '@/app/actions/catalogue-search';
import { useLibrary } from '@/lib/library-context';
import { useNavSearch } from '../AppShell';
import { initialsOf } from '@/lib/prelude';
import { Icon } from '../Icon';

type WorkHeader = Awaited<ReturnType<typeof getCatalogWorkHeader>>;

/**
 * The catalogue: composers → works → recordings. Three columns on the desk,
 * one pane at a time on a phone with a back trail above it.
 */
export function CatalogScreen() {
  const { likedTrackIds } = useLibrary();
  const { query } = useNavSearch();

  const [composers, setComposers] = useState<CatalogComposer[]>([]);
  const [composerId, setComposerId] = useState<string | null>(null);
  const [works, setWorks] = useState<CatalogWork[]>([]);
  const [workId, setWorkId] = useState<string | null>(null);
  const [header, setHeader] = useState<WorkHeader>(null);
  const [recordings, setRecordings] = useState<CatalogRecording[]>([]);
  // Mobile drill-down depth: 0 composers, 1 works, 2 recordings.
  const [level, setLevel] = useState(0);
  const [isNarrow, setIsNarrow] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const sync = () => setIsNarrow(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    getCatalogComposers()
      .then((list) => {
        setComposers(list);
        setComposerId((current) => current ?? list[0]?.id ?? null);
      })
      .catch((err) => console.error('Failed to load the catalogue:', err));
  }, []);

  useEffect(() => {
    if (composerId === null) return;
    let cancelled = false;
    getCatalogWorks(composerId)
      .then((list) => {
        if (cancelled) return;
        setWorks(list);
        setWorkId(list[0]?.id ?? null);
      })
      .catch((err) => console.error('Failed to load works:', err));
    return () => {
      cancelled = true;
    };
  }, [composerId]);

  useEffect(() => {
    if (workId === null) {
      setHeader(null);
      setRecordings([]);
      return;
    }
    let cancelled = false;
    const liked = Array.from(likedTrackIds);
    Promise.all([getCatalogWorkHeader(workId), getCatalogRecordings(workId, liked)])
      .then(([head, recs]) => {
        if (cancelled) return;
        setHeader(head);
        setRecordings(recs);
      })
      .catch((err) => console.error('Failed to load recordings:', err));
    return () => {
      cancelled = true;
    };
    // The liked set only changes the badges; refetching on every heart would
    // be wasteful, so it's read when the work changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return composers;
    return composers.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.era ?? '').toLowerCase().includes(q),
    );
  }, [composers, query]);

  /*
   * Works are searched on the server rather than filtered here, because a
   * catalogue reference has to reach every reference a work carries and only
   * one of them is loaded with the card. A reader who knows a Scarlatti
   * sonata as L 413 should find it even though its card says Kk. 9.
   */
  const [hits, setHits] = useState<WorkSearchHit[]>([]);
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      searchWorks(trimmed)
        .then((found) => {
          if (live) setHits(found);
        })
        .catch(() => {
          if (live) setHits([]);
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [trimmed]);

  const composer = composers.find((c) => c.id === composerId) ?? null;
  const work = works.find((w) => w.id === workId) ?? null;

  const pickComposer = (c: CatalogComposer) => {
    setComposerId(c.id);
    setLevel(1);
  };
  const pickWork = (w: CatalogWork) => {
    setWorkId(w.id);
    setLevel(2);
  };

  return (
    <div className="relative z-[1] flex min-h-screen flex-col pb-[var(--player-h)] max-[900px]:pb-[calc(var(--player-h)+24px)]">
      {/* Breadcrumb trail — mobile only */}
      <div className="hidden items-center gap-2 border-b border-rule bg-paper-2 px-5 py-[10px] font-meta text-[10px] tracking-[0.14em] text-muted uppercase max-[900px]:flex">
        {level > 0 ? (
          <button
            type="button"
            onClick={() => setLevel(level - 1)}
            className="inline-flex cursor-pointer items-center gap-[6px] text-ink-2"
          >
            <Icon name="back" size={12} />
            {level === 1 ? 'Composers' : (composer?.short ?? 'Works')}
          </button>
        ) : (
          <span className="text-ink">Composers</span>
        )}
        {level === 2 && work && (
          <>
            <span className="text-rule">/</span>
            <span className="text-ink">{work.catalog ?? work.title}</span>
          </>
        )}
      </div>

      {trimmed.length >= 2 && (
        <SearchResults
          query={trimmed}
          hits={hits}
          onPick={(hit) => {
            setComposerId(hit.composerId);
            setWorkId(hit.workId);
            setLevel(2);
          }}
        />
      )}

      <div className="grid flex-1 grid-cols-[264px_340px_minmax(0,1fr)] max-[900px]:grid-cols-[minmax(0,1fr)]">
        <ComposerPane
          list={filtered}
          selectedId={composerId}
          onSelect={pickComposer}
          hidden={isNarrow && level !== 0}
        />
        <WorkPane
          composer={composer}
          works={works}
          selectedId={workId}
          onSelect={pickWork}
          hidden={isNarrow && level !== 1}
        />
        <RecordingPane header={header} recordings={recordings} hidden={isNarrow && level !== 2} />
      </div>
    </div>
  );
}

/**
 * What the query found, above the three panes.
 *
 * Shows every catalogue reference each work carries, not just the one that
 * matched, so it is clear why a search for L 413 returned something labelled
 * Kk. 9 — and so the reader learns the work's other names.
 */
function SearchResults({
  query,
  hits,
  onPick,
}: {
  query: string;
  hits: WorkSearchHit[];
  onPick: (hit: WorkSearchHit) => void;
}) {
  return (
    <div className="border-b border-rule bg-paper-2 px-5 py-3">
      <div className="mb-2 font-meta text-[9.5px] tracking-[0.2em] text-muted uppercase">
        {hits.length > 0
          ? `${hits.length} work${hits.length === 1 ? '' : 's'} matching “${query}”`
          : `Nothing matching “${query}”`}
      </div>
      <div className="flex flex-col">
        {hits.map((hit) => (
          <button
            key={hit.workId}
            type="button"
            onClick={() => onPick(hit)}
            className="flex cursor-pointer items-baseline gap-3 border-b border-rule/40 py-[6px] text-left last:border-b-0"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-ink">
                {hit.title}
                {hit.nickname && <span className="text-muted"> “{hit.nickname}”</span>}
              </span>
              <span className="block truncate font-meta text-[10px] text-muted">
                {hit.composerName}
                {hit.references.length > 0 && <> · {hit.references.join(' · ')}</>}
              </span>
            </span>
            <span className="shrink-0 font-meta text-[10px] text-muted tabular-nums">
              {hit.recordingCount === 0
                ? 'no recordings'
                : `${hit.recordingCount} recording${hit.recordingCount === 1 ? '' : 's'}`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const PANE =
  'thin-bar flex min-w-0 max-h-[calc(100vh-var(--nav-h)-var(--player-h))] flex-col overflow-y-auto border-r border-rule last:border-r-0 max-[900px]:max-h-none max-[900px]:overflow-y-visible max-[900px]:border-r-0';

function PaneHead({ title, count }: { title: string; count?: string }) {
  return (
    <div className="sticky top-0 z-[3] flex items-baseline gap-[10px] border-b border-rule bg-paper px-[18px] pt-[14px] pb-[10px] max-[900px]:relative">
      <span className="font-meta text-[9.5px] tracking-[0.2em] text-muted uppercase">{title}</span>
      {count && (
        <span className="ml-auto font-meta text-[9.5px] text-muted tabular-nums">{count}</span>
      )}
    </div>
  );
}

function PaneEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-[26px] py-10 text-center">
      <p className="m-0 max-w-[26ch] font-display text-[15px] leading-[1.5] text-muted italic">
        {children}
      </p>
    </div>
  );
}

/* ---------- Column 1: composers ---------- */
function ComposerPane({
  list,
  selectedId,
  onSelect,
  hidden,
}: {
  list: CatalogComposer[];
  selectedId: string | null;
  onSelect: (c: CatalogComposer) => void;
  hidden: boolean;
}) {
  // A–Z by surname, locale-aware so Pärt files under P.
  const groups = useMemo(() => {
    const sorted = [...list].sort((a, b) => a.sort.localeCompare(b.sort, 'en'));
    const out: { letter: string; items: CatalogComposer[] }[] = [];
    for (const c of sorted) {
      const letter = (c.sort[0] ?? '?').toUpperCase();
      if (out.length === 0 || out[out.length - 1].letter !== letter) {
        out.push({ letter, items: [] });
      }
      out[out.length - 1].items.push(c);
    }
    return out;
  }, [list]);

  const totalWorks = list.reduce((a, c) => a + c.workCount, 0);

  return (
    <div className={`${PANE} ${hidden ? 'hidden' : ''}`}>
      <PaneHead title="Composers" count={`${list.length} · ${totalWorks} works`} />
      {groups.map((g) => (
        // Keyed by the first composer in the run, not the letter: an accented
        // surname can sort between two plain ones and split a letter in two.
        <Fragment key={g.items[0].id}>
          <div className="sticky top-[35px] bg-paper px-[18px] pt-3 pb-1 font-display text-[15px] text-accent italic max-[900px]:top-0 max-[900px]:px-4">
            {g.letter}
          </div>
          {g.items.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c)}
              className={`grid w-full cursor-pointer grid-cols-[30px_1fr_auto] items-center gap-[11px] px-[18px] py-[7px] text-left hover:bg-paper-2 max-[900px]:px-4 ${
                selectedId === c.id ? 'bg-paper-3' : ''
              }`}
            >
              <span
                className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center overflow-hidden rounded-full font-display text-[11px] shadow-[inset_0_0_0_1px_var(--rule)] ${
                  selectedId === c.id ? 'bg-paper text-ink-2' : 'bg-paper-2 text-muted'
                }`}
              >
                <ComposerFace name={c.name} image={c.image} />
              </span>
              <span className="flex min-w-0 flex-col gap-px">
                <span
                  className={`block truncate font-display text-[16px] leading-[1.15] ${
                    selectedId === c.id ? 'font-semibold' : ''
                  }`}
                >
                  {c.short}
                </span>
                <span className="block truncate font-meta text-[9.5px] tracking-[0.04em] text-muted">
                  {c.years || '—'}
                  {c.era ? ` · ${c.era}` : ''}
                </span>
              </span>
              <span className="font-meta text-[10px] text-muted tabular-nums">
                {c.workCount}w · {c.recordingCount}r
              </span>
            </button>
          ))}
        </Fragment>
      ))}
      {list.length === 0 && <PaneEmpty>No composer matches that search.</PaneEmpty>}
    </div>
  );
}

/** The composer's Spotify portrait, falling back to their initials. */
function ComposerFace({ name, image }: { name: string; image: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!image || failed) return <>{initialsOf(name)}</>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Spotify serves already-sized art
    <img
      src={image}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover [filter:grayscale(0.3)_sepia(0.1)]"
    />
  );
}

/* ---------- Column 2: works ---------- */
function WorkPane({
  composer,
  works,
  selectedId,
  onSelect,
  hidden,
}: {
  composer: CatalogComposer | null;
  works: CatalogWork[];
  selectedId: string | null;
  onSelect: (w: CatalogWork) => void;
  hidden: boolean;
}) {
  const byGenre = useMemo(() => {
    // A null genre means `work.form` was never recorded — keep those works
    // visible under a heading that says so, rather than filing them under a
    // category name they didn't earn.
    const map = new Map<string | null, CatalogWork[]>();
    for (const w of works) {
      const bucket = map.get(w.genre);
      if (bucket) bucket.push(w);
      else map.set(w.genre, [w]);
    }
    // Biggest groups first, so the composer's centre of gravity reads first;
    // the unrecorded pile always sits last.
    return Array.from(map).sort((a, b) => {
      if (a[0] === null) return 1;
      if (b[0] === null) return -1;
      return b[1].length - a[1].length || a[0].localeCompare(b[0]);
    });
  }, [works]);

  if (!composer) {
    return (
      <div className={`${PANE} ${hidden ? 'hidden' : ''}`}>
        <PaneHead title="Works" />
        <PaneEmpty>Choose a composer to see their catalogue.</PaneEmpty>
      </div>
    );
  }

  return (
    <div className={`${PANE} ${hidden ? 'hidden' : ''}`}>
      <PaneHead title="Works" count={String(works.length)} />

      <div className="relative border-b border-rule px-[18px] pt-4 pb-[14px] max-[900px]:px-4 max-[900px]:pt-[14px] max-[900px]:pb-3">
        <div className="flex items-start gap-[14px]">
          <span className="flex h-[62px] w-[62px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-paper-2 font-display text-[20px] text-muted shadow-[inset_0_0_0_1px_var(--rule),0_10px_24px_-14px_rgba(40,30,10,0.5)] max-[900px]:h-[52px] max-[900px]:w-[52px]">
            <ComposerFace name={composer.name} image={composer.image} />
          </span>
          <div className="min-w-0">
            <div className="font-display text-2xl leading-[1.08] font-medium max-[900px]:text-[21px]">
              {composer.name}
            </div>
            <div className="mt-[2px] font-display text-[13px] text-muted italic">
              {composer.years || 'dates unknown'}
            </div>
          </div>
        </div>
        <div className="mt-[10px] flex flex-wrap gap-x-[14px] gap-y-1">
          <Fact k="Era" v={composer.era ?? '—'} />
          <Fact k="Works" v={String(composer.workCount)} />
          <Fact k="Recordings" v={String(composer.recordingCount)} />
        </div>
      </div>

      {works.length === 0 && <PaneEmpty>No works are recorded for this composer yet.</PaneEmpty>}
      {byGenre.map(([genre, group]) => (
        <Fragment key={genre ?? '\u0000unrecorded'}>
          <div
            className={`border-b border-rule px-[18px] pt-4 pb-[6px] font-meta text-[9px] tracking-[0.2em] uppercase max-[900px]:px-4 ${
              genre === null ? 'text-accent' : 'text-muted'
            }`}
          >
            {genre ?? 'Form not recorded'}
          </div>
          {group.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => onSelect(w)}
              className={`grid w-full cursor-pointer grid-cols-[1fr_auto] items-baseline gap-3 px-[18px] py-[9px] text-left hover:bg-paper-2 max-[900px]:px-4 ${
                selectedId === w.id ? 'bg-paper-3' : ''
              }`}
            >
              <span
                className={`min-w-0 font-display text-[16px] leading-[1.2] ${
                  selectedId === w.id ? 'font-semibold' : ''
                }`}
              >
                {w.title}
                {w.nickname && (
                  <>
                    , <span className="text-accent italic">“{w.nickname}”</span>
                  </>
                )}
                <span className="mt-[2px] flex items-baseline gap-2 font-meta text-[9.5px] tracking-[0.1em] text-muted uppercase">
                  {w.catalog && <span>{w.catalog}</span>}
                  {w.catalog && w.year && <span>·</span>}
                  {w.year && <span>{w.year}</span>}
                  {w.movementCount > 0 && (
                    <>
                      <span>·</span>
                      <span>
                        {w.movementCount} mvt{w.movementCount !== 1 ? 's' : ''}
                      </span>
                    </>
                  )}
                </span>
              </span>
              <span className="font-display text-[12px] whitespace-nowrap text-muted italic">
                <b className="font-semibold text-ink-2 not-italic">{w.recordingCount}</b> rec.
              </span>
            </button>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <span className="flex flex-col gap-px">
      <span className="font-meta text-[8.5px] tracking-[0.18em] text-muted uppercase">{k}</span>
      <span className="font-display text-[13px] text-ink-2">{v}</span>
    </span>
  );
}

/* ---------- Column 3: recordings ---------- */
function RecordingPane({
  header,
  recordings,
  hidden,
}: {
  header: WorkHeader;
  recordings: CatalogRecording[];
  hidden: boolean;
}) {
  if (!header) {
    return (
      <div className={`${PANE} ${hidden ? 'hidden' : ''}`}>
        <PaneHead title="Recordings" />
        <PaneEmpty>
          Pick a work and every recording of it in the catalogue appears here — the same music,
          differently argued.
        </PaneEmpty>
      </div>
    );
  }

  const mostLiked = recordings.find((r) => r.liked > 0)?.id ?? null;
  const earliest = recordings.reduce<CatalogRecording | null>(
    (best, r) =>
      r.year !== null && (best === null || r.year < (best.year ?? Infinity)) ? r : best,
    null,
  );

  return (
    <div className={`${PANE} ${hidden ? 'hidden' : ''}`}>
      <PaneHead
        title="Recordings"
        count={
          recordings.length > 0 && recordings.every((r) => r.popularity === null)
            ? `${recordings.length} · unranked`
            : String(recordings.length)
        }
      />

      <div className="relative overflow-hidden border-b border-rule px-[26px] pt-[22px] pb-[18px] max-[900px]:px-4 max-[900px]:pt-[18px] max-[900px]:pb-[14px]">
        <div className="mb-[7px] font-meta text-[9px] tracking-[0.2em] text-muted uppercase">
          {header.composerName}
        </div>
        <h2 className="m-0 font-display text-[34px] leading-[1.04] font-medium text-balance max-[900px]:text-[27px]">
          {header.title}
          {header.nickname && (
            <>
              , <span className="text-accent italic">“{header.nickname}”</span>
            </>
          )}
        </h2>
        <div className="mt-[9px] flex flex-wrap items-baseline gap-x-3 gap-y-[6px] font-display text-[13.5px] text-muted italic">
          {header.catalog && (
            <span className="font-meta text-[10px] tracking-[0.14em] text-ink-2 uppercase not-italic">
              {header.catalog}
            </span>
          )}
          {header.year && <span>composed {header.year}</span>}
          {header.movementCount > 0 && (
            <>
              <span className="text-rule">·</span>
              <span>
                {header.movementCount} movement{header.movementCount !== 1 ? 's' : ''}
              </span>
            </>
          )}
          <span className="text-rule">·</span>
          <span>{header.genre ?? 'form not recorded'}</span>
        </div>
      </div>

      <div className="pt-1 pb-10">
        {recordings.length === 0 && (
          <PaneEmpty>No recordings are recorded for this work yet.</PaneEmpty>
        )}
        {recordings.map((r) => (
          <Link
            key={r.id}
            href={`/work/${header.id}?rec=${r.id}`}
            className="group relative grid cursor-pointer grid-cols-[64px_1fr_auto] items-center gap-[18px] border-b border-rule px-[26px] py-[14px] no-underline hover:bg-paper-2 max-[900px]:grid-cols-[56px_1fr] max-[900px]:gap-x-[14px] max-[900px]:gap-y-2 max-[900px]:px-4 max-[900px]:py-3"
          >
            <span
              className="pointer-events-none absolute inset-y-0 left-0 w-[180px] opacity-[0.08] transition-opacity group-hover:opacity-[0.15] max-[900px]:w-[120px]"
              style={{ background: `linear-gradient(90deg, ${r.tint}, transparent)` }}
            />
            <span className="relative h-16 w-16 shrink-0 overflow-hidden shadow-soft max-[900px]:h-14 max-[900px]:w-14">
              {r.cover ? (
                // eslint-disable-next-line @next/next/no-img-element -- Spotify serves already-sized art
                <img
                  src={r.cover}
                  alt={r.album}
                  className="block h-full w-full object-cover transition-transform duration-500 ease-[cubic-bezier(.2,.7,.2,1)] group-hover:scale-105"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-paper-2 font-display text-[15px] text-muted">
                  {initialsOf(r.performer ?? r.album)}
                </span>
              )}
              <span className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.14)]" />
            </span>

            <span className="min-w-0">
              {r.id === mostLiked && (
                <span className="mb-[3px] block font-meta text-[8px] tracking-[0.2em] text-accent uppercase">
                  Your reference
                </span>
              )}
              {r.id !== mostLiked && earliest?.id === r.id && (
                <span className="mb-[3px] block font-meta text-[8px] tracking-[0.2em] text-accent uppercase">
                  Earliest
                </span>
              )}
              {r.unmatched && (
                <span className="mb-[3px] block font-meta text-[8px] tracking-[0.2em] text-accent uppercase">
                  tracks not mapped
                </span>
              )}
              <span className="block truncate font-display text-[18px] leading-[1.15] font-medium">
                {r.performer}
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
              <span className="font-meta text-[10.5px] text-muted tabular-nums">
                {r.duration ?? '—'}
              </span>
              {r.liked > 0 && (
                <span className="inline-flex items-center gap-1 font-meta text-[9.5px] tracking-[0.1em] text-accent">
                  <Icon name="heartFill" size={9} />
                  {r.liked} liked
                </span>
              )}
            </span>
          </Link>
        ))}
        {recordings.length === 0 && (
          <div className="px-[26px] py-[14px] font-display text-[12.5px] text-muted italic max-[900px]:px-4 max-[900px]:py-3">
            No recordings of this work in the catalogue yet.
          </div>
        )}
      </div>
    </div>
  );
}
