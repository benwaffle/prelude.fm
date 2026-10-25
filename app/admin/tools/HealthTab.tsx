'use client';

import Link from 'next/link';
import { getCacheHealth } from '../actions/cache-health';
import { Spinner } from '../components/Spinner';
import { useServerQuery } from '@/lib/use-server-query';
import { LoadFailure } from '@/app/components/LoadFailure';
import { noticeClassName } from '../components/Notice';

type DeployHealth = {
  commit: string | null;
  branch: string | null;
  environment: string;
  reader: string;
  pipeline: string;
  migrations: { count: number | null; latest: number | null };
  invariants: { state: string; failing: string[]; stale: string[]; neverRun: string[] };
};

async function readDeployHealth(): Promise<DeployHealth> {
  const response = await fetch('/api/health');
  if (!response.ok) throw new Error(`${response.status}`);
  return (await response.json()) as DeployHealth;
}

export function HealthTab() {
  const healthQuery = useServerQuery(getCacheHealth, []);
  const deploy = useServerQuery(readDeployHealth, []);

  if (healthQuery.status === 'error') {
    return (
      <LoadFailure
        className={noticeClassName('error')}
        what="cache health"
        error={healthQuery.message}
        onRetry={healthQuery.retry}
      />
    );
  }
  if (healthQuery.status === 'loading') {
    return (
      <div className="flex items-center gap-2 py-16 text-[var(--faint)]">
        <Spinner className="h-3 w-3" />
        <span className="text-xs">Loading…</span>
      </div>
    );
  }
  const health = healthQuery.data;

  return (
    <div className="flex flex-col gap-8 pb-16">
      <section>
        <p className="eyebrow mb-2">Deployment</p>
        <div className="slip px-4 py-4">
          {deploy.status === 'ready' ? (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
              <Fact label="Reader" value={deploy.data.reader} />
              <Fact label="Pipeline" value={deploy.data.pipeline} />
              <Fact label="Environment" value={deploy.data.environment} />
              <Fact label="Commit" value={deploy.data.commit?.slice(0, 7) ?? '—'} mono />
              <Fact label="Branch" value={deploy.data.branch ?? '—'} />
              <Fact
                label="Migrations"
                value={
                  deploy.data.migrations.count === null ? '—' : String(deploy.data.migrations.count)
                }
              />
              <Fact label="Invariant sweep" value={deploy.data.invariants.state} />
            </dl>
          ) : deploy.status === 'error' ? (
            <p className="text-[var(--ink-2)]">
              Could not read deployment facts ({deploy.message}).
            </p>
          ) : (
            <p className="text-[var(--ink-2)]">Reading deployment facts…</p>
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
                  <span className="block text-[11px] text-[var(--ink-2)]">
                    {invariant.checkedAt
                      ? `Last full pass ended ${new Date(invariant.checkedAt).toLocaleDateString()}.`
                      : 'No full pass has ended yet.'}
                    {invariant.sweep &&
                      ` A pass is under way: ${sweepShare(invariant.sweep)}% of the table read, ${invariant.sweep.violations} found so far.`}
                  </span>
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

// The daily sweep reads each check's table a slice a day (`sweepMusicBrainzInvariants`).
function sweepShare(sweep: { cursor: number; end: number }): number {
  return sweep.end === 0 ? 100 : Math.floor((sweep.cursor / sweep.end) * 100);
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="py-1">
      <dt className="text-[11px] text-[var(--ink-2)]">{label}</dt>
      <dd className={mono ? 'mono text-[15px]' : 'text-[15px]'}>{value}</dd>
    </div>
  );
}
