'use client';

import { formatMbPickMeta, type MbPickHit } from '@/lib/musicbrainz-pick';

export function MbPickHitRow({
  hit,
  picked,
  busy,
  onPick,
  children,
}: {
  hit: MbPickHit;
  picked?: boolean;
  busy?: boolean;
  onPick?: (mbid: string) => void;
  children?: React.ReactNode;
}) {
  const meta = formatMbPickMeta(hit);
  return (
    <div className="row px-0">
      <span className="min-w-0 flex-1">
        <a href={hit.href} target="_blank" rel="noreferrer">
          {hit.title}
        </a>
        {meta !== '' && <span className="album-meta">{meta}</span>}
        <span className="mono block text-[11px] text-[var(--ink-2)]">{hit.mbid}</span>
      </span>
      {onPick && (
        <button className="act shrink-0" disabled={busy} onClick={() => onPick(hit.mbid)}>
          {picked ? 'Picked' : 'Pick'}
        </button>
      )}
      {children}
    </div>
  );
}
