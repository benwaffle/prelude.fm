'use client';

import Link from 'next/link';
import { use } from 'react';

// Temporary: reproduce Safari full reloads on library links. Not for merge.
export default function Repro({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = use(searchParams);
  const sp = { get: (k: string) => q[k] ?? null };
  const cv = sp.get('cv') !== '0';
  const pf = sp.get('pf') === '1';
  const n = Number(sp.get('n') ?? 1500);
  return (
    <main className="mx-auto max-w-[1280px] px-6">
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          className={
            cv ? '-mx-6 px-6 [contain-intrinsic-size:auto_220px] [content-visibility:auto]' : ''
          }
        >
          <div className="group relative grid grid-cols-[132px_minmax(0,1fr)] gap-[26px] border-b py-5">
            <Link prefetch={pf ? null : false} href={`/work/w${i}?rec=r${i}`} id={`cover-${i}`}>
              <span className="block aspect-square bg-gray-300" />
            </Link>
            <h2>
              <Link prefetch={pf ? null : false} href={`/work/w${i}?rec=r${i}`} id={`title-${i}`}>
                Work {i}
              </Link>
            </h2>
          </div>
        </div>
      ))}
    </main>
  );
}
