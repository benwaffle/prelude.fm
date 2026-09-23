'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getCacheHealth, type CacheHealth } from '../actions/cache-health';
import { Spinner } from '../components/Spinner';
import { adminFailureMessage, useAdminFailure } from '../components/AdminFailure';

type DeployHealth = {
  commit: string | null;
  branch: string | null;
  environment: string;
  reader: string;
  pipeline: string;
  migrations: { count: number | null; latest: number | null };
  invariants: { state: string; failing: string[]; stale: string[]; neverRun: string[] };
};

/** Cache fill, unsettled-tree samples, and deployment facts for the MusicBrainz reader. */
export function HealthTab() {
  const { showFailure } = useAdminFailure();
  const [health, setHealth] = useState<CacheHealth | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [deploy, setDeploy] = useState<DeployHealth | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

  useEffect(() => {
    getCacheHealth()
      .then(setHealth)
      .catch((error: unknown) => {
        setHealthFailed(true);
        showFailure(error);
      });
    fetch('/api/health')
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status}`);
        return response.json() as Promise<DeployHealth>;
      })
      .then((json) => {
        setDeploy(json);
        setDeployError(null);
      })
      .catch((error: unknown) => {
        setDeploy(null);
        setDeployError(adminFailureMessage(error));
        showFailure(error);
      });
  }, [showFailure]);

  if (!health) {
    if (healthFailed) return <p role="alert">Could not load cache health.</p>;
    return (
      <div className="flex items-center gap-2 py-16 text-[var(--faint)]">
        <Spinner className="h-3 w-3" />
        <span className="text-xs">Loading…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 pb-16">
      <section>
        <p className="eyebrow mb-2">Deployment</p>
        <div className="slip px-4 py-4">
          {deploy ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
              <Fact label="Reader" value={deploy.reader} />
              <Fact label="Pipeline" value={deploy.pipeline} />
              <Fact label="Environment" value={deploy.environment} />
              <Fact label="Commit" value={deploy.commit?.slice(0, 7) ?? '—'} mono />
              <Fact label="Branch" value={deploy.branch ?? '—'} />
              <Fact
                label="Migrations"
                value={deploy.migrations.count === null ? '—' : String(deploy.migrations.count)}
              />
              <Fact label="Invariant sweep" value={deploy.invariants.state} />
            </dl>
          ) : (
            <p className="text-[var(--ink-2)]">
              Could not read deployment facts ({deployError ?? 'unknown'}).
            </p>
          )}
          <p className="mt-3 text-[var(--ink-2)]">
            Full JSON at{' '}
            <Link className="text-[var(--viridian)] underline" href="/api/health">
              /api/health
            </Link>
            .
          </p>
        </div>
      </section>

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

      {health.unsettled.count > 0 && (
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

      {health.invariants.length > 0 && (
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
                {invariant.violations > 0 && invariant.severity !== 'hard' && (
                  <span className="tag shrink-0">
                    {invariant.severity === 'upstream' ? 'theirs, not ours' : 'needs a look'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

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

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="py-1">
      <dt className="text-[11px] text-[var(--ink-2)]">{label}</dt>
      <dd className={mono ? 'mono text-[15px]' : 'text-[15px]'}>{value}</dd>
    </div>
  );
}
