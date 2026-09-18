'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getComposersWithStats, updateComposerDetails } from '../actions/composer-management';
import { refreshSpotifyArtistMetadataMissing } from '../actions/spotify-search';
import type { ComposerRow } from '../actions/schema-types';
import { JsonComposerImport } from '../components/composers/JsonComposerImport';
import { PlaylistComposerImport } from '../components/composers/PlaylistComposerImport';
import { SpotifyArtistSearch } from '../components/composers/SpotifyArtistSearch';
import { Modal } from '../components/Modal';
import { Notice } from '../components/Notice';
import { Spinner } from '../components/Spinner';

type ComposerWithStats = ComposerRow & {
  workCount: number;
  spotifyImages?: { url: string; width: number; height: number }[] | null;
  spotifyPopularity?: number | null;
};

const EMPTY_FORM = { name: '', birthYear: '', deathYear: '', biography: '' };

export function ComposersTab() {
  const [composers, setComposers] = useState<ComposerWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editing, setEditing] = useState<ComposerRow | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<{ by: 'name' | 'popularity'; direction: 'asc' | 'desc' }>({
    by: 'name',
    direction: 'asc',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setComposers(await getComposersWithStats());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load composers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const changed = useCallback(
    async (message: string) => {
      setSuccess(message);
      await load();
    },
    [load],
  );

  const beginEdit = (composer: ComposerWithStats) => {
    setEditing(composer);
    setForm({
      name: composer.name,
      birthYear: composer.birthYear?.toString() ?? '',
      deathYear: composer.deathYear?.toString() ?? '',
      biography: composer.biography ?? '',
    });
  };

  const saveEdit = async () => {
    if (!editing || !form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await updateComposerDetails(editing.id, {
        name: form.name.trim(),
        birthYear: form.birthYear ? Number(form.birthYear) : null,
        deathYear: form.deathYear ? Number(form.deathYear) : null,
        biography: form.biography.trim() || null,
      });
      setEditing(null);
      setForm(EMPTY_FORM);
      await changed(`Updated composer: ${form.name.trim()}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to update composer');
    } finally {
      setSaving(false);
    }
  };

  const refreshMetadata = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await refreshSpotifyArtistMetadataMissing();
      await changed(`Refreshed ${result.updated}/${result.total} artists`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to refresh artist metadata');
    } finally {
      setRefreshing(false);
    }
  };

  const existingArtistIds = useMemo(
    () =>
      new Set(
        composers
          .map((composer) => composer.spotifyArtistId)
          .filter((id): id is string => id !== null),
      ),
    [composers],
  );
  const sorted = useMemo(
    () =>
      [...composers].sort((left, right) => {
        const comparison =
          sort.by === 'popularity'
            ? (left.spotifyPopularity ?? -1) - (right.spotifyPopularity ?? -1)
            : left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
        return sort.direction === 'asc' ? comparison : -comparison;
      }),
    [composers, sort],
  );

  if (loading && composers.length === 0) {
    return (
      <div className="flex justify-center py-12">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error && <Notice variant="error">{error}</Notice>}
      {success && <Notice variant="success">{success}</Notice>}

      <ComposerEditModal
        composer={editing}
        form={form}
        saving={saving}
        onFormChange={setForm}
        onClose={() => setEditing(null)}
        onSave={saveEdit}
      />

      <PlaylistComposerImport onChanged={changed} />
      <SpotifyArtistSearch existingArtistIds={existingArtistIds} onChanged={changed} />
      <JsonComposerImport onChanged={changed} />

      <section className="overflow-hidden border border-[var(--rule)] bg-[var(--slip)]">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--rule)] bg-[var(--slip-2)] px-4 py-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">
              Composers ({composers.length})
            </h2>
            <p className="text-sm text-[var(--ink-2)]">All composers in the database</p>
          </div>
          <button
            onClick={refreshMetadata}
            disabled={refreshing}
            className="flex items-center gap-2 border border-[var(--rule)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {refreshing && <Spinner />}
            {refreshing ? 'Refreshing...' : 'Refresh missing Spotify metadata'}
          </button>
        </header>
        <div className="max-h-[520px] overflow-y-auto">
          <table className="w-full">
            <thead className="sticky top-0 bg-[var(--slip-2)] text-xs text-[var(--ink-2)]">
              <tr>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-left">Years</th>
                <th className="px-4 py-2 text-left">
                  <button
                    onClick={() =>
                      setSort((current) => ({
                        by: 'popularity',
                        direction:
                          current.by === 'popularity' && current.direction === 'desc'
                            ? 'asc'
                            : 'desc',
                      }))
                    }
                  >
                    Popularity {sort.by === 'popularity' && (sort.direction === 'asc' ? '↑' : '↓')}
                  </button>
                </th>
                <th className="px-4 py-2 text-left">Works</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {sorted.map((composer) => (
                <tr key={composer.id} className="border-t border-[var(--rule)]">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {composer.spotifyImages?.at(-1)?.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={composer.spotifyImages.at(-1)!.url}
                          alt=""
                          className="h-10 w-10 rounded-full object-cover"
                        />
                      ) : (
                        <span className="h-10 w-10 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                      )}
                      <span className="font-medium text-[var(--ink)]">{composer.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[var(--ink-2)]">
                    {composer.birthYear === null && composer.deathYear === null
                      ? 'not recorded'
                      : `${composer.birthYear ?? '?'}–${composer.deathYear ?? '?'}`}
                  </td>
                  <td className="px-4 py-3 text-[var(--ink-2)]">
                    {composer.spotifyPopularity ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-[var(--ink-2)]">{composer.workCount}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => beginEdit(composer)}
                      className="rounded border border-[var(--rule)] px-3 py-1 text-xs"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ComposerEditModal({
  composer,
  form,
  saving,
  onFormChange,
  onClose,
  onSave,
}: {
  composer: ComposerRow | null;
  form: typeof EMPTY_FORM;
  saving: boolean;
  onFormChange: (form: typeof EMPTY_FORM) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  if (!composer) return null;
  return (
    <Modal isOpen onClose={onClose} className="max-w-md">
      <h3 className="mb-4 text-lg font-semibold text-[var(--ink)]">Edit Composer</h3>
      <div className="space-y-4">
        {(['name', 'birthYear', 'deathYear'] as const).map((field) => (
          <label key={field} className="block text-sm text-[var(--ink-2)]">
            {field === 'name' ? 'Name' : field === 'birthYear' ? 'Birth Year' : 'Death Year'}
            <input
              type={field === 'name' ? 'text' : 'number'}
              value={form[field]}
              onChange={(event) => onFormChange({ ...form, [field]: event.target.value })}
              className="mt-1 w-full border border-[var(--rule)] bg-[var(--slip)] px-3 py-2 text-[var(--ink)] bg-[var(--slip-2)]"
            />
          </label>
        ))}
        <label className="block text-sm text-[var(--ink-2)]">
          Biography
          <textarea
            value={form.biography}
            onChange={(event) => onFormChange({ ...form, biography: event.target.value })}
            rows={3}
            className="mt-1 w-full border border-[var(--rule)] bg-[var(--slip)] px-3 py-2 text-[var(--ink)] bg-[var(--slip-2)]"
          />
        </label>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onClose} className="border px-4 py-2">
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-2 bg-[var(--gall)] px-4 py-2 text-white disabled:opacity-50"
        >
          {saving && <Spinner />}
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
