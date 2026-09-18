'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  getCatalogueHealth,
  getContestedWorks,
  getDisagreements,
  resolveDisagreement,
  type CatalogueHealth,
  type Disagreement,
  type DisagreementField,
} from '../actions/catalogue-health';
import { Spinner } from '../components/Spinner';

type ContestedGroup = {
  mbid: string;
  works: { id: number; title: string; composerName: string }[];
};

export function DeskTab({
  onSwitchTab,
}: {
  onSwitchTab: (tab: 'queue' | 'works' | 'composers') => void;
}) {
  const [health, setHealth] = useState<CatalogueHealth | null>(null);
  const [field, setField] = useState<DisagreementField | undefined>();
  const [variants, setVariants] = useState<{ rows: Disagreement[]; total: number } | null>(null);
  const [contested, setContested] = useState<ContestedGroup[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [nextHealth, nextVariants, nextContested] = await Promise.all([
      getCatalogueHealth(),
      getDisagreements(field, 40),
      getContestedWorks(12),
    ]);
    setHealth(nextHealth);
    setVariants(nextVariants);
    setContested(nextContested);
    setLoading(false);
  }, [field]);

  useEffect(() => {
    void load();
  }, [load]);

  async function settle(row: Disagreement, choice: 'ours' | 'theirs') {
    setBusy(row.key);
    try {
      await resolveDisagreement(
        row.field,
        row.entityId,
        choice,
        choice === 'theirs' ? row.theirs : row.ours,
      );
      setVariants((current) =>
        current
          ? { rows: current.rows.filter((r) => r.key !== row.key), total: current.total - 1 }
          : current,
      );
    } finally {
      setBusy(null);
    }
  }

  if (loading || !health) {
    return (
      <div className="flex items-center gap-2 py-16 text-[var(--faint)]">
        <Spinner className="h-3 w-3" />
        <span className="text-xs">Reading the catalogue…</span>
      </div>
    );
  }

  const openGaps = health.gaps.filter((gap) => gap.count > 0);
  const settledGaps = health.gaps.filter((gap) => gap.count === 0);

  return (
    <div className="flex flex-col gap-9 pb-16">
      {/*
        The page opens on what is missing rather than on what is held. The
        catalogue is incomplete and will stay that way for a while, so the
        counts worth putting first are the ones that say where the work is.
      */}
      <section>
        <p className="eyebrow mb-3">What the catalogue doesn&rsquo;t know</p>
        {openGaps.length === 0 ? (
          <p className="text-[var(--viridian)]">
            Nothing outstanding. Every gap has either a value or a recorded reason.
          </p>
        ) : (
          <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-3">
            {openGaps.map((gap) => (
              <button
                key={gap.id}
                className="gap"
                disabled={!gap.tab}
                onClick={() => gap.tab && onSwitchTab(gap.tab)}
              >
                <span className="gap-n">{gap.count.toLocaleString()}</span>
                <span className="gap-label">{gap.label}</span>
              </button>
            ))}
          </div>
        )}
        {settledGaps.length > 0 && (
          <p className="mt-3 text-[11px] text-[var(--faint)]">
            Closed: {settledGaps.map((gap) => gap.label).join(' · ')}
          </p>
        )}
      </section>

      {/* What a second source independently confirms, and how far it reaches. */}
      <section>
        <p className="eyebrow mb-3">Reach of the second source</p>
        <div className="slip grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-5">
          {[
            { label: 'tracks matched', held: health.tracksMatched, total: health.tracks },
            { label: 'works linked', held: health.worksLinked, total: health.works },
            { label: 'movements linked', held: health.partsLinked, total: health.parts },
            { label: 'composers linked', held: health.composersLinked, total: health.composers },
          ].map((row) => (
            <div key={row.label} className="px-3 py-3">
              <p className="mono text-[15px] leading-none">
                {row.held.toLocaleString()}
                <span className="text-[var(--faint)]"> / {row.total.toLocaleString()}</span>
              </p>
              <p className="eyebrow mt-1.5">{row.label}</p>
            </div>
          ))}
          <div className="px-3 py-3">
            <p className="mono text-[15px] leading-none text-[var(--viridian)]">
              {health.importedCatalogues.toLocaleString()}
            </p>
            <p className="eyebrow mt-1.5">catalogue refs added</p>
          </div>
        </div>
      </section>

      {/*
        Two sources holding different values for one field. Set as a critical
        edition sets a variant reading — ours, the bracket, theirs — because
        neither is presumed correct and the notation already says so.
      */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <p className="eyebrow">Variant readings</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              className="act"
              data-variant={field === undefined ? undefined : 'keep'}
              onClick={() => setField(undefined)}
              disabled={field === undefined}
            >
              All{' '}
              {variants ? `(${health.disagreementsByField.reduce((a, b) => a + b.count, 0)})` : ''}
            </button>
            {health.disagreementsByField.map((row) => (
              <button
                key={row.field}
                className="act"
                onClick={() => setField(row.field)}
                disabled={field === row.field}
              >
                {row.label} ({row.count})
              </button>
            ))}
          </div>
        </div>

        {!variants || variants.rows.length === 0 ? (
          <div className="slip px-4 py-6 text-[var(--ink-2)]">
            Nothing to settle here. Where both sources hold a value and they differ, the row appears
            here until someone decides.
          </div>
        ) : (
          <>
            <div className="slip">
              {variants.rows.map((row) => (
                <div key={row.key} className="apparatus">
                  <span className="app-context">{row.context}</span>
                  <span className="app-lemma">{row.ours}</span>
                  <span className="app-bracket" aria-label="against">
                    ]
                  </span>
                  <span className="app-variant">{row.theirs}</span>
                  <span className="app-siglum" title="MusicBrainz">
                    MB
                  </span>
                  <span className="flex gap-1.5">
                    <button
                      className="act"
                      data-quiet="true"
                      disabled={busy === row.key}
                      onClick={() => settle(row, 'theirs')}
                    >
                      Take theirs
                    </button>
                    <button
                      className="act"
                      data-quiet="true"
                      data-variant="keep"
                      disabled={busy === row.key}
                      onClick={() => settle(row, 'ours')}
                    >
                      Keep ours
                    </button>
                  </span>
                </div>
              ))}
            </div>
            {variants.total > variants.rows.length && (
              <p className="mt-2 text-[11px] text-[var(--faint)]">
                Showing {variants.rows.length} of {variants.total.toLocaleString()}. Settle these
                and the next load brings more.
              </p>
            )}
          </>
        )}
      </section>

      {/*
        Several of our works resolving onto one MusicBrainz work. Usually they
        duplicate each other — which a title comparison would not catch, since
        these agree on identity rather than on wording.
      */}
      {contested.length > 0 && (
        <section>
          <p className="eyebrow mb-1">Works that may be duplicates</p>
          <p className="mb-3 max-w-prose text-[11px] text-[var(--faint)]">
            Each group resolves onto one MusicBrainz work. That usually means these rows are the
            same piece entered more than once. None are linked until the group is resolved.
          </p>
          <div className="slip">
            {contested.map((group) => (
              <div key={group.mbid} className="rule-b px-4 py-2.5 last:border-b-0">
                <a
                  className="mono text-[10px] text-[var(--faint)] hover:text-[var(--gall)]"
                  href={`https://musicbrainz.org/work/${group.mbid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {group.mbid}
                </a>
                <ul className="mt-1">
                  {group.works.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="mono text-[11px] text-[var(--faint)]">{item.id}</span>
                      <span>{item.title}</span>
                      <span className="w-full text-[11px] text-[var(--faint)] sm:w-auto sm:text-[13px]">
                        {item.composerName}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
