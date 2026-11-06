'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { getMusicBrainzCatalogComposers } from '@/app/actions/catalog-mb';
import type { CatalogComposer } from '@/lib/library-types';
import { useServerQuery } from '@/lib/use-server-query';
import { useNavSearch } from '../AppShell';
import { LoadFailure } from '../LoadFailure';
import { catalogHref } from './catalog-url';

const THIS_YEAR = new Date().getFullYear();
// With no death year on record, someone born this recently may well be alive, so their bar runs
// to today, open-ended. Anyone older gets a birth mark only: we don't know when they died.
const MAY_BE_LIVING_YEARS = 105;

/** Every listed composer's life on one axis, oldest first. */
export function ComposerTimeline() {
  const { query } = useNavSearch();
  const composers = useServerQuery(getMusicBrainzCatalogComposers, []);
  const all = useMemo(
    () => (composers.status === 'ready' ? composers.data.composers : []),
    [composers],
  );

  const q = query.trim().toLowerCase();
  const shown = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
  const dated = shown
    .filter((c): c is CatalogComposer & { born: number } => c.born !== null)
    .sort((a, b) => a.born - b.born || (a.died ?? THIS_YEAR) - (b.died ?? THIS_YEAR));
  const undated = shown.filter((c) => c.born === null);

  // The axis spans everyone listed, not just the search, so bars don't jump while typing.
  const births = all.flatMap((c) => (c.born === null ? [] : [c.born]));
  const start = births.length ? Math.floor(Math.min(...births) / 50) * 50 : 1600;
  const span = THIS_YEAR - start;
  const at = (year: number) => ((year - start) / span) * 100;
  const ticks: number[] = [];
  for (let year = start; year <= THIS_YEAR; year += 50) ticks.push(year);

  return (
    <div className="relative z-[1] min-h-screen px-7 pt-5 pb-[calc(var(--player-h)+24px)] max-[900px]:px-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="m-0 font-display text-[22px] font-medium italic">Composers through time</h1>
        <Link
          href={catalogHref(null)}
          className="font-meta text-[10px] tracking-[0.14em] text-muted uppercase"
        >
          Back to the list
        </Link>
        {composers.status === 'ready' && (
          <span className="ml-auto font-meta text-[10px] text-muted tabular-nums">
            {dated.length} with a birth year · {undated.length} without
          </span>
        )}
      </div>

      {composers.status === 'error' && (
        <LoadFailure what="the composers" error={composers.message} onRetry={composers.retry} />
      )}
      {composers.status === 'loading' && (
        <p className="font-display text-[15px] text-muted italic">Loading composers…</p>
      )}

      {composers.status === 'ready' && (
        <div className="relative">
          <div className="sticky top-[66px] z-[2] h-6 border-b border-rule bg-paper max-[900px]:top-[58px]">
            {ticks.map((year) => (
              <span
                key={year}
                className="absolute bottom-1 -translate-x-1/2 font-meta text-[9.5px] text-muted tabular-nums first:translate-x-0"
                style={{ left: `${at(year)}%` }}
              >
                {year % 100 === 0 || ticks.length < 10 ? year : ''}
              </span>
            ))}
          </div>
          <div className="relative">
            {ticks.map((year) => (
              <span
                key={year}
                aria-hidden
                className={`absolute inset-y-0 w-px ${year % 100 === 0 ? 'bg-rule' : 'bg-rule/40'}`}
                style={{ left: `${at(year)}%` }}
              />
            ))}
            {dated.map((c) => (
              <LifeRow key={c.id} composer={c} at={at} />
            ))}
            {dated.length === 0 && (
              <p className="relative py-6 font-display text-[15px] text-muted italic">
                No composer with a birth year matches that search.
              </p>
            )}
          </div>

          {undated.length > 0 && (
            <div className="mt-6 border-t border-rule pt-3">
              <p className="m-0 mb-2 font-meta text-[10px] tracking-[0.04em] text-muted">
                No birth year on record, so not placed on the timeline:
              </p>
              <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
                {undated.map((c) => (
                  <li key={c.id} className="font-display text-[15px]">
                    <Link href={catalogHref(c.id)} className="text-ink">
                      {c.short}
                    </Link>
                    {c.died !== null && (
                      <span className="ml-1 font-meta text-[9.5px] text-muted">d. {c.died}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LifeRow({
  composer: c,
  at,
}: {
  composer: CatalogComposer & { born: number };
  at: (year: number) => number;
}) {
  const openEnded = c.died === null && THIS_YEAR - c.born <= MAY_BE_LIVING_YEARS;
  const end = c.died ?? (openEnded ? THIS_YEAR : c.born);
  const left = at(c.born);
  const right = at(end);
  // Names sit after the bar, or before it when the bar reaches the right-hand side.
  const labelBefore = right > 72;
  const years = c.died !== null ? `${c.born}–${c.died}` : `b. ${c.born}, no death year on record`;

  return (
    <Link
      href={catalogHref(c.id)}
      title={`${c.name} · ${years}`}
      className="group relative block h-[19px] text-ink no-underline hover:bg-paper-2"
    >
      {c.died === null && !openEnded ? (
        <span
          className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent bg-paper"
          style={{ left: `${left}%` }}
        />
      ) : (
        <span
          className={`absolute top-1/2 h-[9px] min-w-[3px] -translate-y-1/2 rounded-[1px] bg-accent/75 group-hover:bg-accent ${
            openEnded
              ? 'rounded-r-none [mask-image:linear-gradient(to_right,black_75%,transparent)]'
              : ''
          }`}
          style={{ left: `${left}%`, width: `${right - left}%` }}
        />
      )}
      <span
        className="absolute top-1/2 -translate-y-1/2 bg-paper/85 px-1 font-display text-[13px] leading-none whitespace-nowrap"
        style={
          labelBefore ? { right: `calc(${100 - left}% + 2px)` } : { left: `calc(${right}% + 2px)` }
        }
      >
        {c.short}
        <span className="ml-[6px] font-meta text-[9.5px] text-muted tabular-nums">{years}</span>
      </span>
    </Link>
  );
}
