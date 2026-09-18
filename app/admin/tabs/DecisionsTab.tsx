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
import { getUnconfirmedWorks } from '../actions/coverage';
import { Spinner } from '../components/Spinner';

type ContestedGroup = {
  mbid: string;
  works: { id: number; title: string; composerName: string }[];
};

const FIELD_NAME: Record<DisagreementField, string> = {
  birth_year: 'birth year',
  death_year: 'death year',
  work_type: 'form',
  part_title: 'movement title',
};

export function DecisionsTab() {
  const [health, setHealth] = useState<CatalogueHealth | null>(null);
  const [field, setField] = useState<DisagreementField | undefined>();
  const [conflicts, setConflicts] = useState<{ rows: Disagreement[]; total: number } | null>(null);
  const [duplicates, setDuplicates] = useState<ContestedGroup[]>([]);
  const [unconfirmed, setUnconfirmed] = useState<
    { id: number; title: string; form: string | null; parts: number; recordings: number }[]
  >([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [nextHealth, nextConflicts, nextDuplicates, nextUnconfirmed] = await Promise.all([
      getCatalogueHealth(),
      getDisagreements(field, 25),
      getContestedWorks(10),
      getUnconfirmedWorks(15),
    ]);
    setHealth(nextHealth);
    setConflicts(nextConflicts);
    setDuplicates(nextDuplicates);
    setUnconfirmed(nextUnconfirmed);
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
      setConflicts((current) =>
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
        <span className="text-xs">Loading…</span>
      </div>
    );
  }

  const totalConflicts = health.disagreementsByField.reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="flex flex-col gap-8 pb-16">
      <p className="max-w-[70ch] text-[var(--ink-2)]">
        Everything here needs a person. MusicBrainz either disagrees with us, points two of our
        works at one of its own, or has nothing to say at all.
      </p>
      <section>
        <p className="eyebrow mb-2">Conflicts with MusicBrainz</p>
        <p className="mb-3 max-w-[70ch] text-[var(--ink-2)]">
          Fields where we and MusicBrainz both have a value and the two differ. Ours is often the
          more specific one, so these are not necessarily mistakes — pick whichever is right.
          Nothing changes until you choose.
        </p>

        {totalConflicts > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              className="act"
              onClick={() => setField(undefined)}
              disabled={field === undefined}
            >
              All ({totalConflicts.toLocaleString()})
            </button>
            {health.disagreementsByField.map((row) => (
              <button
                key={row.field}
                className="act"
                onClick={() => setField(row.field)}
                disabled={field === row.field}
              >
                {FIELD_NAME[row.field]} ({row.count.toLocaleString()})
              </button>
            ))}
          </div>
        )}

        {!conflicts || conflicts.rows.length === 0 ? (
          <div className="slip px-4 py-5 text-[var(--ink-2)]">Nothing to decide.</div>
        ) : (
          <>
            <div className="slip">
              {conflicts.rows.map((row) => (
                <div key={row.key} className="conflict">
                  <div className="conflict-head">
                    <span className="truncate">{row.context}</span>
                    <span className="tag">{FIELD_NAME[row.field]}</span>
                  </div>
                  <dl className="conflict-values">
                    <dt>Ours</dt>
                    <dd>{row.ours}</dd>
                    <dt>MusicBrainz</dt>
                    <dd>{row.theirs}</dd>
                  </dl>
                  <div className="conflict-actions">
                    <button
                      className="act"
                      disabled={busy === row.key}
                      onClick={() => settle(row, 'ours')}
                    >
                      Keep ours
                    </button>
                    <button
                      className="act"
                      data-variant="primary"
                      disabled={busy === row.key}
                      onClick={() => settle(row, 'theirs')}
                    >
                      Use MusicBrainz
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {conflicts.total > conflicts.rows.length && (
              <p className="mt-2 text-[11px] text-[var(--faint)]">
                {conflicts.rows.length} of {conflicts.total.toLocaleString()} shown.
              </p>
            )}
          </>
        )}
      </section>

      {unconfirmed.length > 0 && (
        <section>
          <p className="eyebrow mb-2">Works MusicBrainz has never confirmed</p>
          <p className="mb-3 max-w-[70ch] text-[var(--ink-2)]">
            The parser created these from track titles and nothing has corroborated them. Anchoring
            the albums they appear on is what confirms or corrects them — the ones with the most
            recordings are worth the most.
          </p>
          <div className="slip">
            {unconfirmed.map((item) => (
              <div key={item.id} className="row">
                <span className="mono w-10 shrink-0 text-[11px] text-[var(--faint)]">
                  {item.id}
                </span>
                <span className="min-w-0 flex-1">
                  {item.title}
                  {item.form && <span className="text-[var(--faint)]"> · {item.form}</span>}
                </span>
                <span className="mono shrink-0 text-[11px] text-[var(--faint)]">
                  {item.recordings} rec · {item.parts} mvt
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {duplicates.length > 0 && (
        <section>
          <p className="eyebrow mb-2">Possible duplicate works</p>
          <p className="mb-3 max-w-[70ch] text-[var(--ink-2)]">
            Each group points at the same work in MusicBrainz, which usually means the same piece
            was entered more than once here.
          </p>
          <div className="slip">
            {duplicates.map((group) => (
              <div key={group.mbid} className="rule-b px-4 py-3 last:border-b-0">
                <ul>
                  {group.works.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="mono text-[11px] text-[var(--faint)]">{item.id}</span>
                      <span>{item.title}</span>
                      <span className="text-[11px] text-[var(--faint)]">{item.composerName}</span>
                    </li>
                  ))}
                </ul>
                <a
                  className="mono mt-1 inline-block text-[10px] text-[var(--faint)] hover:text-[var(--gall)]"
                  href={`https://musicbrainz.org/work/${group.mbid}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  view in musicbrainz →
                </a>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
