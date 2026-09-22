'use client';

import type { ReactNode } from 'react';
import { type MbPickHit } from '@/lib/musicbrainz-pick';
import { MbPickHitRow } from './MbPickHitRow';

export function MbPicker({
  seed,
  hits,
  loading = false,
  status,
  busy = false,
  pickedMbid,
  pickNote,
  onLookup,
  onPick,
  renderHitActions,
}: {
  seed: string;
  hits: MbPickHit[];
  loading?: boolean;
  status?: string | null;
  busy?: boolean;
  pickedMbid?: string;
  pickNote: ReactNode;
  onLookup?: () => void;
  onPick?: (mbid: string) => void;
  renderHitActions?: (hit: MbPickHit) => ReactNode;
}) {
  const hasSeed = seed.trim() !== '';

  return (
    <div className="mb-picker">
      <p className="mb-2 text-[11px] text-[var(--ink-2)]">{pickNote}</p>
      {!hasSeed && hits.length === 0 ? (
        <p className="absent">No lookup seed is available.</p>
      ) : loading ? (
        <p className="text-[var(--ink-2)]">Looking up MusicBrainz…</p>
      ) : hits.length > 0 ? (
        hits.map((hit) => (
          <MbPickHitRow
            key={hit.mbid}
            hit={hit}
            picked={pickedMbid === hit.mbid}
            busy={busy}
            onPick={onPick}
          >
            {renderHitActions?.(hit)}
          </MbPickHitRow>
        ))
      ) : (
        <p className="text-[var(--ink-2)]">No MusicBrainz hits for this evidence.</p>
      )}
      {status && !loading && <p className="mt-2 text-[var(--ink-2)]">{status}</p>}
      {onLookup && hasSeed && (
        <button className="act mt-2" disabled={busy || loading} onClick={onLookup}>
          {loading ? 'Looking up…' : 'Look up on MusicBrainz'}
        </button>
      )}
    </div>
  );
}
