'use client';

import { useState } from 'react';
import { initialsOf, type LibraryWork } from '@/lib/prelude';

interface ComposerRow {
  full: string;
  short: string;
  image: string | null;
  liked: number;
  works: number;
}

/**
 * The composers behind the library, as a scrolling row of monograms.
 * Picking one filters the library to that name.
 */
export function ComposerStrip({
  works,
  onPick,
}: {
  works: LibraryWork[];
  onPick: (composer: string) => void;
}) {
  const byComposer = new Map<string, ComposerRow>();
  for (const w of works) {
    const liked = w.movements.filter((m) => m.liked).length;
    // A work we cannot attribute has no composer to file it under. It stays
    // in the library; it just is not in this strip.
    if (!liked || !w.composerFull) continue;
    const row = byComposer.get(w.composerFull) ?? {
      full: w.composerFull,
      short: w.composer ?? w.composerFull,
      image: w.composerImage,
      liked: 0,
      works: 0,
    };
    row.liked += liked;
    row.works += 1;
    byComposer.set(w.composerFull, row);
  }
  const list = Array.from(byComposer.values()).sort((a, b) => b.liked - a.liked);
  if (list.length === 0) return null;

  return (
    <>
      <div className="flex items-baseline gap-3 pt-[30px] pb-[6px] max-[900px]:pt-[22px] max-[900px]:pb-1">
        <span className="font-display text-[22px] font-medium whitespace-nowrap italic max-[900px]:text-[19px]">
          Composers in your library
        </span>
        <span className="h-px flex-1 self-center bg-rule" />
        <span className="font-meta text-[10px] tracking-[0.16em] whitespace-nowrap text-muted uppercase">
          {list.length}
        </span>
      </div>

      <div className="thin-bar flex gap-[22px] overflow-x-auto pt-[18px] pb-6 max-[900px]:gap-[14px] max-[900px]:pt-[14px] max-[900px]:pb-5">
        {list.map((c) => (
          <button
            key={c.full}
            type="button"
            onClick={() => onPick(c.short)}
            className="group flex w-[112px] min-w-[112px] cursor-pointer flex-col gap-[7px] max-[900px]:w-[84px] max-[900px]:min-w-[84px]"
          >
            <span className="aspect-square w-full overflow-hidden rounded-full bg-paper-2 shadow-soft transition-all duration-[260ms] group-hover:-translate-y-[3px] group-hover:filter-none [filter:grayscale(0.35)_sepia(0.12)_contrast(1.02)]">
              <Portrait name={c.full} image={c.image} />
            </span>
            <span className="font-display text-[14px] leading-[1.15] font-bold max-[900px]:text-[12.5px]">
              {c.short}
            </span>
            <span className="font-meta text-[9px] tracking-[0.14em] text-muted uppercase max-[900px]:text-[8px]">
              {c.liked} mvt{c.liked !== 1 ? 's' : ''} · {c.works} work{c.works !== 1 ? 's' : ''}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

/** The composer's Spotify portrait, falling back to a monogram. */
function Portrait({ name, image }: { name: string; image: string | null }) {
  const [failed, setFailed] = useState(false);

  if (!image || failed) {
    return (
      <span className="onum flex h-full w-full items-center justify-center bg-paper-2 font-display text-[34px] font-medium text-muted shadow-[inset_0_0_0_1px_var(--rule)] max-[900px]:text-[24px]">
        {initialsOf(name)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- Spotify serves already-sized art
    <img
      src={image}
      alt={name}
      loading="lazy"
      onError={() => setFailed(true)}
      className="block h-full w-full object-cover"
    />
  );
}
