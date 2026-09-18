'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  searchWorks,
  getWorkWithDetails,
  createWork,
  updateWorkDetails,
  addMovementToWork,
  updateMovementDetails,
  deleteMovement,
  type WorkWithDetails,
  type AdminWorkPart,
} from '../actions/work-management';
import { searchComposers } from '../actions/composer-management';
import type { ComposerRow, RecordingRow } from '../actions/schema-types';
import { Spinner } from '../components/Spinner';
import { Notice } from '../components/Notice';
import { Modal } from '../components/Modal';
import { toRoman } from '../lib/format';

interface WorkDetails {
  work: {
    id: number;
    composerId: number;
    title: string;
    nickname: string | null;
    catalogSystem: string | null;
    catalogNumber: string | null;
    yearComposed: number | null;
    form: string | null;
  };
  composer: ComposerRow;
  movements: AdminWorkPart[];
  recordings: Array<RecordingRow & { albumTitle: string }>;
}

export function WorksTab() {
  const [works, setWorks] = useState<WorkWithDetails[]>([]);
  const [totalWorks, setTotalWorks] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Search/filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterComposerId, setFilterComposerId] = useState<number | undefined>();
  const [filterCatalogSystem, setFilterCatalogSystem] = useState('');
  const [composers, setComposers] = useState<ComposerRow[]>([]);

  // Work detail view
  const [selectedWork, setSelectedWork] = useState<WorkDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Create/Edit work modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingWork, setEditingWork] = useState<WorkWithDetails | null>(null);
  const [workForm, setWorkForm] = useState({
    composerId: '',
    title: '',
    nickname: '',
    catalogSystem: '',
    catalogNumber: '',
    yearComposed: '',
    form: '',
  });

  // Movement management
  const [addingMovement, setAddingMovement] = useState(false);
  const [newMovement, setNewMovement] = useState({ position: '', label: '', title: '' });
  const [editingMovement, setEditingMovement] = useState<AdminWorkPart | null>(null);
  const [movementForm, setMovementForm] = useState({ position: '', label: '', title: '' });

  // Saving states
  const [saving, setSaving] = useState(false);

  // Pagination
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(0);

  const loadComposers = useCallback(async () => {
    try {
      const results = await searchComposers('');
      setComposers(results);
    } catch (err) {
      console.error('Failed to load composers:', err);
    }
  }, []);

  const loadWorks = useCallback(
    async (options?: {
      query?: string;
      composerId?: number;
      catalogSystem?: string;
      page?: number;
    }) => {
      const { query, composerId, catalogSystem, page: pageArg = 0 } = options ?? {};
      setLoading(true);
      setError(null);
      try {
        const result = await searchWorks(
          query || undefined,
          composerId,
          catalogSystem || undefined,
          PAGE_SIZE,
          pageArg * PAGE_SIZE,
        );
        setWorks(result.items);
        setTotalWorks(result.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load works');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    loadComposers();
    loadWorks();
  }, [loadComposers, loadWorks]);

  const handleSearch = () => {
    setPage(0);
    loadWorks({
      query: searchQuery || undefined,
      composerId: filterComposerId,
      catalogSystem: filterCatalogSystem || undefined,
      page: 0,
    });
  };

  const goToPage = (next: number) => {
    setPage(next);
    loadWorks({
      query: searchQuery || undefined,
      composerId: filterComposerId,
      catalogSystem: filterCatalogSystem || undefined,
      page: next,
    });
  };

  const handleViewWorkDetails = async (workId: number) => {
    setLoadingDetails(true);
    setError(null);
    try {
      const details = await getWorkWithDetails(workId);
      setSelectedWork(details);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load work details');
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleCreateWork = async () => {
    if (!workForm.composerId || !workForm.title.trim()) return;

    setSaving(true);
    setError(null);

    try {
      await createWork({
        composerId: parseInt(workForm.composerId),
        title: workForm.title.trim(),
        nickname: workForm.nickname.trim() || null,
        catalogSystem: workForm.catalogSystem.trim() || null,
        catalogNumber: workForm.catalogNumber.trim() || null,
        yearComposed: workForm.yearComposed ? parseInt(workForm.yearComposed) : null,
        form: workForm.form.trim() || null,
      });

      setSuccessMessage(`Created work: ${workForm.title}`);
      setShowCreateModal(false);
      resetWorkForm();
      await loadWorks({
        query: searchQuery || undefined,
        composerId: filterComposerId,
        catalogSystem: filterCatalogSystem || undefined,
        page,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create work');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateWork = async () => {
    if (!editingWork || !workForm.title.trim()) return;

    setSaving(true);
    setError(null);

    try {
      await updateWorkDetails(editingWork.id, {
        title: workForm.title.trim(),
        nickname: workForm.nickname.trim() || null,
        catalogSystem: workForm.catalogSystem.trim() || null,
        catalogNumber: workForm.catalogNumber.trim() || null,
        yearComposed: workForm.yearComposed ? parseInt(workForm.yearComposed) : null,
        form: workForm.form.trim() || null,
      });

      setSuccessMessage(`Updated work: ${workForm.title}`);
      setEditingWork(null);
      resetWorkForm();
      await loadWorks({
        query: searchQuery || undefined,
        composerId: filterComposerId,
        catalogSystem: filterCatalogSystem || undefined,
        page,
      });

      // Refresh details if viewing this work
      if (selectedWork?.work.id === editingWork.id) {
        await handleViewWorkDetails(editingWork.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update work');
    } finally {
      setSaving(false);
    }
  };

  const handleAddMovement = async () => {
    if (!selectedWork || !newMovement.position) return;

    setSaving(true);
    setError(null);

    try {
      await addMovementToWork(
        selectedWork.work.id,
        parseInt(newMovement.position),
        newMovement.label.trim() || null,
        newMovement.title.trim() || null,
      );

      setSuccessMessage(`Added work part ${newMovement.position}`);
      setAddingMovement(false);
      setNewMovement({ position: '', label: '', title: '' });
      await handleViewWorkDetails(selectedWork.work.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add movement');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateMovement = async () => {
    if (!editingMovement || !movementForm.position) return;

    setSaving(true);
    setError(null);

    try {
      await updateMovementDetails(editingMovement.id, {
        position: parseInt(movementForm.position),
        label: movementForm.label.trim() || null,
        title: movementForm.title.trim() || null,
      });

      setSuccessMessage(`Updated work part ${movementForm.position}`);
      setEditingMovement(null);
      setMovementForm({ position: '', label: '', title: '' });
      if (selectedWork) {
        await handleViewWorkDetails(selectedWork.work.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update movement');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMovement = async (movementId: number) => {
    if (!confirm('Are you sure you want to delete this movement?')) return;

    setSaving(true);
    setError(null);

    try {
      await deleteMovement(movementId);
      setSuccessMessage('Movement deleted');
      if (selectedWork) {
        await handleViewWorkDetails(selectedWork.work.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete movement');
    } finally {
      setSaving(false);
    }
  };

  const startEditingWork = (work: WorkWithDetails) => {
    setEditingWork(work);
    setWorkForm({
      composerId: work.composerId.toString(),
      title: work.title,
      nickname: work.nickname || '',
      catalogSystem: work.catalogSystem || '',
      catalogNumber: work.catalogNumber || '',
      yearComposed: work.yearComposed?.toString() || '',
      form: work.form || '',
    });
  };

  const startEditingMovement = (mvmt: AdminWorkPart) => {
    setEditingMovement(mvmt);
    setMovementForm({
      position: mvmt.position.toString(),
      label: mvmt.label || '',
      title: mvmt.title || '',
    });
  };

  const resetWorkForm = () => {
    setWorkForm({
      composerId: '',
      title: '',
      nickname: '',
      catalogSystem: '',
      catalogNumber: '',
      yearComposed: '',
      form: '',
    });
  };

  return (
    <div className="space-y-6">
      {error && <Notice variant="error">{error}</Notice>}

      {successMessage && <Notice variant="success">{successMessage}</Notice>}

      {/* Create/Edit Work Modal */}
      {(showCreateModal || editingWork) && (
        <Modal
          isOpen={Boolean(showCreateModal || editingWork)}
          onClose={() => {
            setShowCreateModal(false);
            setEditingWork(null);
          }}
          className="max-w-lg"
        >
          <h3 className="text-lg font-semibold text-[var(--ink)] mb-4">
            {editingWork ? 'Edit Work' : 'Create Work'}
          </h3>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ink-2)] mb-1">
                  Catalog System
                </label>
                <input
                  type="text"
                  value={workForm.catalogSystem}
                  onChange={(e) => setWorkForm({ ...workForm, catalogSystem: e.target.value })}
                  placeholder="Op."
                  className="w-full px-3 py-2 border border-[var(--rule)] bg-[var(--slip)] text-[var(--ink)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ink-2)] mb-1">
                  Catalog Number
                </label>
                <input
                  type="text"
                  value={workForm.catalogNumber}
                  onChange={(e) => setWorkForm({ ...workForm, catalogNumber: e.target.value })}
                  placeholder="27/2"
                  className="w-full px-3 py-2 border border-[var(--rule)] bg-[var(--slip)] text-[var(--ink)]"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--ink-2)] mb-1">Nickname</label>
              <input
                type="text"
                value={workForm.nickname}
                onChange={(e) => setWorkForm({ ...workForm, nickname: e.target.value })}
                placeholder="Moonlight"
                className="w-full px-3 py-2 border border-[var(--rule)] bg-[var(--slip)] text-[var(--ink)]"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ink-2)] mb-1">
                  Year Composed
                </label>
                <input
                  type="number"
                  value={workForm.yearComposed}
                  onChange={(e) => setWorkForm({ ...workForm, yearComposed: e.target.value })}
                  placeholder="1801"
                  className="w-full px-3 py-2 border border-[var(--rule)] bg-[var(--slip)] text-[var(--ink)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ink-2)] mb-1">Form</label>
                <input
                  type="text"
                  value={workForm.form}
                  onChange={(e) => setWorkForm({ ...workForm, form: e.target.value })}
                  placeholder="sonata"
                  className="w-full px-3 py-2 border border-[var(--rule)] bg-[var(--slip)] text-[var(--ink)]"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <button
              onClick={() => {
                setShowCreateModal(false);
                setEditingWork(null);
                resetWorkForm();
              }}
              className="px-4 py-2 border border-[var(--rule)] text-[var(--ink-2)] hover:bg-[var(--slip-2)]"
            >
              Cancel
            </button>
            <button
              onClick={editingWork ? handleUpdateWork : handleCreateWork}
              disabled={saving || !workForm.title.trim() || (!editingWork && !workForm.composerId)}
              className="px-4 py-2 bg-[var(--gall)] text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
            >
              {saving && <Spinner />}
              {saving ? 'Saving...' : editingWork ? 'Save' : 'Create'}
            </button>
          </div>
        </Modal>
      )}

      {/* Work Details Panel */}
      {selectedWork && (
        <Modal
          isOpen={Boolean(selectedWork)}
          onClose={() => setSelectedWork(null)}
          className="max-w-2xl max-h-[80vh] overflow-y-auto"
        >
          <div className="flex justify-between items-start mb-4">
            <div>
              <h3 className="text-lg font-semibold text-[var(--ink)]">{selectedWork.work.title}</h3>
              <p className="text-sm text-[var(--ink-2)]">
                {selectedWork.composer.name}
                {selectedWork.work.catalogSystem && selectedWork.work.catalogNumber && (
                  <>
                    {' '}
                    · {selectedWork.work.catalogSystem} {selectedWork.work.catalogNumber}
                  </>
                )}
                {selectedWork.work.nickname && <> · &quot;{selectedWork.work.nickname}&quot;</>}
              </p>
            </div>
            <button
              onClick={() => setSelectedWork(null)}
              className="text-[var(--faint)] hover:text-zinc-700 dark:hover:text-zinc-300"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Work metadata */}
          <div className="mb-6 p-3 bg-[var(--slip-2)] text-sm">
            <div className="grid grid-cols-2 gap-2">
              {selectedWork.work.form && (
                <div>
                  <span className="text-[var(--faint)]">Form:</span> {selectedWork.work.form}
                </div>
              )}
              {selectedWork.work.yearComposed && (
                <div>
                  <span className="text-[var(--faint)]">Year:</span>{' '}
                  {selectedWork.work.yearComposed}
                </div>
              )}
            </div>
          </div>

          {/* Movements */}
          <div className="mb-6">
            <div className="flex justify-between items-center mb-3">
              <h4 className="font-medium text-[var(--ink)]">
                Work parts ({selectedWork.movements.length})
              </h4>
              <button
                onClick={() => setAddingMovement(true)}
                className="text-xs px-3 py-1 rounded bg-[var(--gall)] text-white hover:opacity-90"
              >
                Add work part
              </button>
            </div>

            {addingMovement && (
              <div className="mb-4 p-3 border border-[var(--rule)]">
                <div className="flex gap-2 mb-2">
                  <input
                    type="number"
                    value={newMovement.position}
                    onChange={(e) => setNewMovement({ ...newMovement, position: e.target.value })}
                    placeholder="Position"
                    className="w-16 px-2 py-1 text-sm rounded border border-[var(--rule)] bg-[var(--slip)]"
                  />
                  <input
                    type="text"
                    value={newMovement.label}
                    onChange={(e) => setNewMovement({ ...newMovement, label: e.target.value })}
                    placeholder="Label"
                    className="w-24 px-2 py-1 text-sm rounded border border-[var(--rule)] bg-[var(--slip)]"
                  />
                  <input
                    type="text"
                    value={newMovement.title}
                    onChange={(e) => setNewMovement({ ...newMovement, title: e.target.value })}
                    placeholder="Movement title (optional)"
                    className="flex-1 px-2 py-1 text-sm rounded border border-[var(--rule)] bg-[var(--slip)]"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => {
                      setAddingMovement(false);
                      setNewMovement({ position: '', label: '', title: '' });
                    }}
                    className="text-xs px-3 py-1 rounded border border-[var(--rule)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddMovement}
                    disabled={saving || !newMovement.position}
                    className="text-xs px-3 py-1 rounded bg-[var(--gall)] text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Add'}
                  </button>
                </div>
              </div>
            )}

            {selectedWork.movements.length === 0 ? (
              <p className="text-sm text-[var(--faint)]">No work parts yet.</p>
            ) : (
              <div className="space-y-2">
                {selectedWork.movements.map((mvmt) => (
                  <div
                    key={mvmt.id}
                    className="flex items-center justify-between p-2 bg-[var(--slip-2)] rounded"
                  >
                    {editingMovement?.id === mvmt.id ? (
                      <div className="flex-1 flex gap-2 items-center">
                        <input
                          type="number"
                          value={movementForm.position}
                          onChange={(e) =>
                            setMovementForm({ ...movementForm, position: e.target.value })
                          }
                          className="w-16 px-2 py-1 text-sm rounded border border-[var(--rule)] bg-[var(--slip)]"
                        />
                        <input
                          type="text"
                          value={movementForm.label}
                          onChange={(e) =>
                            setMovementForm({ ...movementForm, label: e.target.value })
                          }
                          placeholder="Label"
                          className="w-24 px-2 py-1 text-sm rounded border border-[var(--rule)] bg-[var(--slip)]"
                        />
                        <input
                          type="text"
                          value={movementForm.title}
                          onChange={(e) =>
                            setMovementForm({ ...movementForm, title: e.target.value })
                          }
                          placeholder="Title (optional)"
                          className="flex-1 px-2 py-1 text-sm rounded border border-[var(--rule)] bg-[var(--slip)]"
                        />
                        <button
                          onClick={() => {
                            setEditingMovement(null);
                            setMovementForm({ position: '', label: '', title: '' });
                          }}
                          className="text-xs px-2 py-1 rounded border border-[var(--rule)]"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleUpdateMovement}
                          disabled={saving || !movementForm.position}
                          className="text-xs px-2 py-1 rounded bg-[var(--gall)] text-white"
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <>
                        <div>
                          <span className="font-mono text-[var(--ink-2)]">
                            {mvmt.label || toRoman(mvmt.position)}.
                          </span>{' '}
                          <span className="text-[var(--ink)]">
                            {mvmt.title || <span className="text-[var(--faint)]">Untitled</span>}
                          </span>
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() => startEditingMovement(mvmt)}
                            className="text-xs px-2 py-1 rounded border border-[var(--rule)] hover:bg-[var(--slip-2)]"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteMovement(mvmt.id)}
                            className="text-xs px-2 py-1 rounded border border-red-300 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recordings */}
          <div>
            <h4 className="font-medium text-[var(--ink)] mb-3">
              Recordings ({selectedWork.recordings.length})
            </h4>
            {selectedWork.recordings.length === 0 ? (
              <p className="text-sm text-[var(--faint)]">No recordings linked yet.</p>
            ) : (
              <div className="space-y-2">
                {selectedWork.recordings.map((rec) => (
                  <div key={rec.id} className="p-2 bg-[var(--slip-2)] rounded text-sm">
                    <div className="text-[var(--ink)]">{rec.albumTitle}</div>
                    <div className="text-xs text-[var(--faint)]">{rec.spotifyAlbumId}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Search and Filters */}
      <div className="border border-[var(--rule)] bg-[var(--slip)] p-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-[var(--ink-2)] mb-1">Search</label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Title, nickname, or catalog number..."
              className="w-full px-3 py-2 border border-[var(--rule)] bg-[var(--slip)] text-[var(--ink)]"
            />
          </div>

          <div className="w-48">
            <label className="block text-sm font-medium text-[var(--ink-2)] mb-1">Composer</label>
            <select
              value={filterComposerId || ''}
              onChange={(e) =>
                setFilterComposerId(e.target.value ? parseInt(e.target.value) : undefined)
              }
              className="w-full px-3 py-2 border border-[var(--rule)] bg-[var(--slip)] text-[var(--ink)]"
            >
              <option value="">All composers</option>
              {composers.map((comp) => (
                <option key={comp.id} value={comp.id}>
                  {comp.name}
                </option>
              ))}
            </select>
          </div>

          <div className="w-32">
            <label className="block text-sm font-medium text-[var(--ink-2)] mb-1">Catalog</label>
            <input
              type="text"
              value={filterCatalogSystem}
              onChange={(e) => setFilterCatalogSystem(e.target.value)}
              placeholder="BWV, Op., K."
              className="w-full px-3 py-2 border border-[var(--rule)] bg-[var(--slip)] text-[var(--ink)]"
            />
          </div>

          <button
            onClick={handleSearch}
            disabled={loading}
            className="px-4 py-2 bg-[var(--gall)] text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
          >
            {loading && <Spinner />}
            Search
          </button>

          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 bg-[var(--viridian)] text-white hover:opacity-90"
          >
            Create Work
          </button>
        </div>
      </div>

      {/* Works List */}
      <div className="border border-[var(--rule)] bg-[var(--slip)] overflow-hidden">
        <div className="px-4 py-3 bg-[var(--slip-2)] border-b border-[var(--rule)]">
          <h2 className="text-lg font-semibold text-[var(--ink)]">Works ({totalWorks})</h2>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner className="w-8 h-8" />
            <span className="ml-2 text-[var(--ink-2)]">Loading...</span>
          </div>
        ) : works.length === 0 ? (
          <div className="px-4 py-8 text-center text-[var(--faint)]">
            No works found. Try adjusting your search or create a new work.
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-[var(--slip-2)] text-xs text-[var(--ink-2)]">
              <tr>
                <th className="px-2 py-1 text-left">Composer</th>
                <th className="px-2 py-1 text-left">Title</th>
                <th className="px-2 py-1 text-left">Catalog</th>
                <th className="px-2 py-1 text-left">Form</th>
                <th className="px-2 py-1 text-left">Year</th>
                <th className="px-2 py-1 text-left">Movements</th>
                <th className="px-2 py-1 text-left">Recordings</th>
                <th className="px-2 py-1 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="text-xs">
              {works.map((work) => (
                <tr key={work.id} className="border-t border-[var(--rule)]">
                  <td className="px-2 py-1 text-[var(--ink-2)]">{work.composerName}</td>
                  <td className="px-2 py-1">
                    <span className="text-[var(--ink)]">{work.title}</span>
                    {work.nickname && (
                      <span className="text-xs text-[var(--faint)] ml-2">
                        &quot;{work.nickname}&quot;
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-[var(--ink-2)]">
                    {work.catalogSystem && work.catalogNumber
                      ? `${work.catalogSystem} ${work.catalogNumber}`
                      : '-'}
                  </td>
                  <td className="px-2 py-1 text-[var(--ink-2)]">{work.form || '-'}</td>
                  <td className="px-2 py-1 text-[var(--ink-2)]">{work.yearComposed ?? '-'}</td>
                  <td className="px-2 py-1 text-[var(--ink-2)]">{work.movementCount}</td>
                  <td className="px-2 py-1 text-[var(--ink-2)]">{work.recordingCount}</td>
                  <td className="px-2 py-1 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => handleViewWorkDetails(work.id)}
                        disabled={loadingDetails}
                        className="text-xs px-2 py-0.5 rounded bg-[var(--gall)] text-white hover:opacity-90"
                      >
                        View
                      </button>
                      <button
                        onClick={() => startEditingWork(work)}
                        className="text-xs px-2 py-0.5 rounded border border-[var(--rule)] text-[var(--ink-2)] hover:bg-[var(--slip-2)]"
                      >
                        Edit
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {totalWorks > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--rule)] text-sm">
            <div className="text-[var(--ink-2)]">
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalWorks)} of{' '}
              {totalWorks}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => goToPage(page - 1)}
                disabled={loading || page === 0}
                className="px-3 py-1 rounded border border-[var(--rule)] text-[var(--ink-2)] hover:bg-[var(--slip-2)] disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => goToPage(page + 1)}
                disabled={loading || (page + 1) * PAGE_SIZE >= totalWorks}
                className="px-3 py-1 rounded border border-[var(--rule)] text-[var(--ink-2)] hover:bg-[var(--slip-2)] disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
