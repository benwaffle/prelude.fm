'use client';

import { useEffect, useState } from 'react';
import { getCoverage, STATE_LABEL, type AlbumState, type Coverage } from '../actions/coverage';
import { Spinner } from '../components/Spinner';

/** What each state costs to fix, said plainly. */
const WHAT_IT_NEEDS: Record<AlbumState, string> = {
  anchored: 'MusicBrainz can describe every track. Nothing to do.',
  partial: 'Some tracks have no ISRC registered in MusicBrainz. Submitting them anchors the rest.',
  needs_isrcs:
    'MusicBrainz has the release but none of our ISRCs. Submitting them anchors the album.',
  absent:
    'No release with this barcode exists in MusicBrainz. It has to be added before anything else.',
  ambiguous:
    'Several releases share this barcode, so none identifies the album. Pick the right one by hand.',
  unchecked: 'Not yet looked up. Run `pnpm mb:backfill releases`.',
};

export function CoverageTab({ onPick }: { onPick: (state: AlbumState) => void }) {
  const [coverage, setCoverage] = useState<Coverage | null>(null);

  useEffect(() => {
    void getCoverage().then(setCoverage);
  }, []);

  if (!coverage) {
    return (
      <div className="flex items-center gap-2 py-16 text-[var(--faint)]">
        <Spinner className="h-3 w-3" />
        <span className="text-xs">Loading…</span>
      </div>
    );
  }

  const share = coverage.tracks ? Math.round((coverage.anchoredTracks / coverage.tracks) * 100) : 0;

  return (
    <div className="flex flex-col gap-8 pb-16">
      <section>
        <p className="eyebrow mb-2">How much of the library MusicBrainz can describe</p>
        <div className="slip px-4 py-4">
          <p className="mono text-[26px] leading-none">
            {share}%
            <span className="ml-3 text-[13px] text-[var(--faint)]">
              {coverage.anchoredTracks.toLocaleString()} of {coverage.tracks.toLocaleString()}{' '}
              tracks
            </span>
          </p>
          {/* One bar, one number. Everything below explains the remainder. */}
          <div className="mt-3 flex h-1.5 w-full overflow-hidden bg-[var(--slip-2)]">
            <div className="bg-[var(--viridian)]" style={{ width: `${share}%` }} />
          </div>
          <p className="mt-3 max-w-[70ch] text-[var(--ink-2)]">
            A track is anchored when its ISRC resolves to a MusicBrainz recording. Anchored tracks
            take their work, movement and composer from MusicBrainz; the rest fall back to what the
            parser guessed from the track title.
          </p>
        </div>
      </section>

      <section>
        <p className="eyebrow mb-2">What the rest needs</p>
        <div className="slip">
          {coverage.byState.map((row) => (
            <button
              key={row.state}
              className="row w-full text-left"
              onClick={() => onPick(row.state)}
            >
              <span
                className={`mono w-12 shrink-0 text-[15px] ${
                  row.state === 'anchored' ? 'text-[var(--viridian)]' : 'text-[var(--gall)]'
                }`}
              >
                {row.albums}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">{STATE_LABEL[row.state]}</span>
                <span className="block text-[11px] text-[var(--ink-2)]">
                  {WHAT_IT_NEEDS[row.state]}
                </span>
              </span>
              <span className="mono shrink-0 text-[11px] text-[var(--faint)]">
                {row.tracks.toLocaleString()} tracks
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
