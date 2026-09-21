'use client';

import { useEffect, useState } from 'react';
import { getCoverage } from '../actions/coverage';
import { getCacheHealth, type CacheHealth } from '../actions/cache-health';
import { STATE_LABEL, type AlbumState, type Coverage } from '../lib/album-state';
import { Spinner } from '../components/Spinner';

/** What each state costs to fix, said plainly. */
const WHAT_IT_NEEDS: Record<AlbumState, string> = {
  anchored: 'MusicBrainz can describe every track. Nothing to do.',
  partial:
    'Some tracks resolve and some do not. Where MusicBrainz has the release, the rest need their ISRCs submitting; where it does not, these recordings are in MusicBrainz under some other release and this one still needs adding.',
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
  const [health, setHealth] = useState<CacheHealth | null>(null);

  useEffect(() => {
    void getCoverage().then(setCoverage);
    getCacheHealth()
      .then(setHealth)
      .catch(() => setHealth(null));
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

      {health && (
        <section>
          <p className="eyebrow mb-2">The MusicBrainz cache</p>
          <div className="slip px-4 py-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
              <Figure
                label="Albums cached"
                value={health.cache.albumsCached}
                of={health.cache.albums}
              />
              <Figure
                label="Tracks anchored"
                value={health.cache.tracksAnchored}
                of={health.cache.tracks}
              />
              <Figure
                label="Reaching a work"
                value={health.cache.tracksReachingWork}
                of={health.cache.tracks}
              />
              <Figure label="Works read" value={health.cache.worksRead} of={health.cache.works} />
              <Figure label="Works with a parent" value={health.cache.worksWithParent} />
              <Figure label="Credits" value={health.cache.credits} />
            </dl>
            <p className="mt-3 max-w-[70ch] text-[var(--ink-2)]">
              Anchored means a track is tied to a MusicBrainz recording, by its ISRC or by its
              position on a release whose tracklist lines up. Reaching a work means MusicBrainz also
              says what that recording is a performance of.
            </p>
          </div>
        </section>
      )}

      {health && health.unsettled.count > 0 && (
        <section>
          <p className="eyebrow mb-2">Works whose place in the tree is unsettled</p>
          <div className="slip">
            <p className="px-4 pt-3 text-[var(--ink-2)]">
              {health.unsettled.count} works are childless, untyped, and titled without naming their
              parent. Each is either a movement whose parent is written differently or a piece
              inside a collection, and those want opposite answers. They stay where they are:
              folding a piece into its collection cannot be spotted afterwards.
            </p>
            {health.unsettled.samples.map((work) => (
              <div key={work.mbid} className="row">
                <span className="min-w-0 flex-1">
                  <span className="block">{work.title}</span>
                  <span className="block text-[11px] text-[var(--ink-2)]">
                    filed under {work.parentTitle}
                  </span>
                </span>
                <a
                  className="act shrink-0"
                  href={`https://musicbrainz.org/work/${work.mbid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Work
                </a>
              </div>
            ))}
          </div>
        </section>
      )}

      {health && health.invariants.length > 0 && (
        <section>
          <p className="eyebrow mb-2">Cache checks</p>
          <div className="slip">
            {health.invariants.map((invariant) => (
              <div key={invariant.name} className="row">
                <span
                  className="mono w-12 shrink-0"
                  style={{
                    color:
                      invariant.violations === 0
                        ? 'var(--viridian)'
                        : invariant.severity === 'hard'
                          ? 'var(--gall)'
                          : 'var(--ink-2)',
                  }}
                >
                  {invariant.violations}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">{invariant.name}</span>
                  {invariant.violations > 0 && (
                    <span className="block text-[11px] text-[var(--ink-2)]">
                      {invariant.describes}
                    </span>
                  )}
                </span>
                {invariant.severity === 'upstream' && invariant.violations > 0 && (
                  <span className="tag shrink-0">theirs, not ours</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** One counted figure, with the total it is a part of when there is one. */
function Figure({ label, value, of }: { label: string; value: number; of?: number }) {
  return (
    <div className="py-1">
      <dt className="text-[11px] text-[var(--ink-2)]">{label}</dt>
      <dd className="mono text-[15px]">
        {value.toLocaleString()}
        {of !== undefined && (
          <span className="text-[11px] text-[var(--faint)]"> / {of.toLocaleString()}</span>
        )}
      </dd>
    </div>
  );
}
