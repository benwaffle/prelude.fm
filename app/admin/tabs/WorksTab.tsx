"use client";

import { useState, useEffect, useCallback } from "react";
import {
  searchWorks,
  searchComposers,
  getWorkWithDetails,
  createWork,
  updateWorkDetails,
  addMovementToWork,
  updateMovementDetails,
  deleteMovement,
  type WorkWithDetails,
  type ComposerRow,
  type MovementRow,
  type RecordingRow,
} from "../actions";

function Spinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

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
  movements: MovementRow[];
  recordings: Array<RecordingRow & { albumTitle: string }>;
}

export function WorksTab() {
  const [works, setWorks] = useState<WorkWithDetails[]>([]);
  const [totalWorks, setTotalWorks] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Search/filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [filterComposerId, setFilterComposerId] = useState<number | undefined>();
  const [filterCatalogSystem, setFilterCatalogSystem] = useState("");
  const [composers, setComposers] = useState<ComposerRow[]>([]);

  // Work detail view
  const [selectedWork, setSelectedWork] = useState<WorkDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Create/Edit work modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingWork, setEditingWork] = useState<WorkWithDetails | null>(null);
  const [workForm, setWorkForm] = useState({
    composerId: "",
    title: "",
    nickname: "",
    catalogSystem: "",
    catalogNumber: "",
    yearComposed: "",
    form: "",
  });

  // Movement management
  const [addingMovement, setAddingMovement] = useState(false);
  const [newMovement, setNewMovement] = useState({ number: "", title: "" });
  const [editingMovement, setEditingMovement] = useState<MovementRow | null>(null);
  const [movementForm, setMovementForm] = useState({ number: "", title: "" });

  // Saving states
  const [saving, setSaving] = useState(false);

  const loadComposers = useCallback(async () => {
    try {
      const results = await searchComposers("");
      setComposers(results);
    } catch (err) {
      console.error("Failed to load composers:", err);
    }
  }, []);

  const loadWorks = useCallback(async (options?: { query?: string; composerId?: number; catalogSystem?: string }) => {
    const { query, composerId, catalogSystem } = options ?? {};
    setLoading(true);
    setError(null);
    try {
      const result = await searchWorks(
        query || undefined,
        composerId,
        catalogSystem || undefined
      );
      setWorks(result.items);
      setTotalWorks(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load works");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadComposers();
    loadWorks();
  }, [loadComposers, loadWorks]);

  const handleSearch = () => {
    loadWorks({
      query: searchQuery || undefined,
      composerId: filterComposerId,
      catalogSystem: filterCatalogSystem || undefined,
    });
  };

  const handleViewWorkDetails = async (workId: number) => {
    setLoadingDetails(true);
    setError(null);
    try {
      const details = await getWorkWithDetails(workId);
      setSelectedWork(details);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load work details");
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
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create work");
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
      });

      // Refresh details if viewing this work
      if (selectedWork?.work.id === editingWork.id) {
        await handleViewWorkDetails(editingWork.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update work");
    } finally {
      setSaving(false);
    }
  };

  const handleAddMovement = async () => {
    if (!selectedWork || !newMovement.number) return;

    setSaving(true);
    setError(null);

    try {
      await addMovementToWork(
        selectedWork.work.id,
        parseInt(newMovement.number),
        newMovement.title.trim() || null
      );

      setSuccessMessage(`Added movement ${newMovement.number}`);
      setAddingMovement(false);
      setNewMovement({ number: "", title: "" });
      await handleViewWorkDetails(selectedWork.work.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add movement");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateMovement = async () => {
    if (!editingMovement || !movementForm.number) return;

    setSaving(true);
    setError(null);

    try {
      await updateMovementDetails(editingMovement.id, {
        number: parseInt(movementForm.number),
        title: movementForm.title.trim() || null,
      });

      setSuccessMessage(`Updated movement ${movementForm.number}`);
      setEditingMovement(null);
      setMovementForm({ number: "", title: "" });
      if (selectedWork) {
        await handleViewWorkDetails(selectedWork.work.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update movement");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMovement = async (movementId: number) => {
    if (!confirm("Are you sure you want to delete this movement?")) return;

    setSaving(true);
    setError(null);

    try {
      await deleteMovement(movementId);
      setSuccessMessage("Movement deleted");
      if (selectedWork) {
        await handleViewWorkDetails(selectedWork.work.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete movement");
    } finally {
      setSaving(false);
    }
  };

  const startEditingWork = (work: WorkWithDetails) => {
    setEditingWork(work);
    setWorkForm({
      composerId: work.composerId.toString(),
      title: work.title,
      nickname: work.nickname || "",
      catalogSystem: work.catalogSystem || "",
      catalogNumber: work.catalogNumber || "",
      yearComposed: work.yearComposed?.toString() || "",
      form: work.form || "",
    });
  };

  const startEditingMovement = (mvmt: MovementRow) => {
    setEditingMovement(mvmt);
    setMovementForm({
      number: mvmt.number.toString(),
      title: mvmt.title || "",
    });
  };

  const resetWorkForm = () => {
    setWorkForm({
      composerId: "",
      title: "",
      nickname: "",
      catalogSystem: "",
      catalogNumber: "",
      yearComposed: "",
      form: "",
    });
  };

  const toRoman = (num: number): string => {
    const romanNumerals: [number, string][] = [
      [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]
    ];
    let result = "";
    for (const [value, symbol] of romanNumerals) {
      while (num >= value) {
        result += symbol;
        num -= value;
      }
    }
    return result;
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {successMessage && (
        <div className="rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20 px-4 py-3 text-green-700 dark:text-green-300">
          {successMessage}
        </div>
      )}

      {/* Create/Edit Work Modal */}
      {(showCreateModal || editingWork) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-zinc-900 rounded-lg p-6 max-w-lg w-full mx-4 shadow-xl">
            <h3 className="text-lg font-semibold text-black dark:text-white mb-4">
              {editingWork ? "Edit Work" : "Create Work"}
            </h3>

            <div className="space-y-4">
              {!editingWork && (
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    Composer *
                  </label>
                  <select
                    value={workForm.composerId}
                    onChange={(e) => setWorkForm({ ...workForm, composerId: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
                  >
                    <option value="">Select composer...</option>
                    {composers.map((comp) => (
                      <option key={comp.id} value={comp.id}>
                        {comp.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  Title *
                </label>
                <input
                  type="text"
                  value={workForm.title}
                  onChange={(e) => setWorkForm({ ...workForm, title: e.target.value })}
                  placeholder="Piano Sonata No. 14 in C-sharp minor"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    Catalog System
                  </label>
                  <input
                    type="text"
                    value={workForm.catalogSystem}
                    onChange={(e) => setWorkForm({ ...workForm, catalogSystem: e.target.value })}
                    placeholder="Op."
                    className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    Catalog Number
                  </label>
                  <input
                    type="text"
                    value={workForm.catalogNumber}
                    onChange={(e) => setWorkForm({ ...workForm, catalogNumber: e.target.value })}
                    placeholder="27/2"
                    className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  Nickname
                </label>
                <input
                  type="text"
                  value={workForm.nickname}
                  onChange={(e) => setWorkForm({ ...workForm, nickname: e.target.value })}
                  placeholder="Moonlight"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    Year Composed
                  </label>
                  <input
                    type="number"
                    value={workForm.yearComposed}
                    onChange={(e) => setWorkForm({ ...workForm, yearComposed: e.target.value })}
                    placeholder="1801"
                    className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    Form
                  </label>
                  <input
                    type="text"
                    value={workForm.form}
                    onChange={(e) => setWorkForm({ ...workForm, form: e.target.value })}
                    placeholder="sonata"
                    className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
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
                className="px-4 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={editingWork ? handleUpdateWork : handleCreateWork}
                disabled={saving || !workForm.title.trim() || (!editingWork && !workForm.composerId)}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {saving && <Spinner />}
                {saving ? "Saving..." : editingWork ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Work Details Panel */}
      {selectedWork && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-zinc-900 rounded-lg p-6 max-w-2xl w-full mx-4 shadow-xl max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-lg font-semibold text-black dark:text-white">
                  {selectedWork.work.title}
                </h3>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {selectedWork.composer.name}
                  {selectedWork.work.catalogSystem && selectedWork.work.catalogNumber && (
                    <> · {selectedWork.work.catalogSystem} {selectedWork.work.catalogNumber}</>
                  )}
                  {selectedWork.work.nickname && (
                    <> · &quot;{selectedWork.work.nickname}&quot;</>
                  )}
                </p>
              </div>
              <button
                onClick={() => setSelectedWork(null)}
                className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Work metadata */}
            <div className="mb-6 p-3 bg-zinc-50 dark:bg-zinc-800 rounded-lg text-sm">
              <div className="grid grid-cols-2 gap-2">
                {selectedWork.work.form && (
                  <div>
                    <span className="text-zinc-500">Form:</span> {selectedWork.work.form}
                  </div>
                )}
                {selectedWork.work.yearComposed && (
                  <div>
                    <span className="text-zinc-500">Year:</span> {selectedWork.work.yearComposed}
                  </div>
                )}
              </div>
            </div>

            {/* Movements */}
            <div className="mb-6">
              <div className="flex justify-between items-center mb-3">
                <h4 className="font-medium text-black dark:text-white">
                  Movements ({selectedWork.movements.length})
                </h4>
                <button
                  onClick={() => setAddingMovement(true)}
                  className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                >
                  Add Movement
                </button>
              </div>

              {addingMovement && (
                <div className="mb-4 p-3 border border-zinc-200 dark:border-zinc-700 rounded-lg">
                  <div className="flex gap-2 mb-2">
                    <input
                      type="number"
                      value={newMovement.number}
                      onChange={(e) => setNewMovement({ ...newMovement, number: e.target.value })}
                      placeholder="#"
                      className="w-16 px-2 py-1 text-sm rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                    />
                    <input
                      type="text"
                      value={newMovement.title}
                      onChange={(e) => setNewMovement({ ...newMovement, title: e.target.value })}
                      placeholder="Movement title (optional)"
                      className="flex-1 px-2 py-1 text-sm rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => {
                        setAddingMovement(false);
                        setNewMovement({ number: "", title: "" });
                      }}
                      className="text-xs px-3 py-1 rounded border border-zinc-300 dark:border-zinc-600"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddMovement}
                      disabled={saving || !newMovement.number}
                      className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {saving ? "Saving..." : "Add"}
                    </button>
                  </div>
                </div>
              )}

              {selectedWork.movements.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">No movements yet.</p>
              ) : (
                <div className="space-y-2">
                  {selectedWork.movements.map((mvmt) => (
                    <div
                      key={mvmt.id}
                      className="flex items-center justify-between p-2 bg-zinc-50 dark:bg-zinc-800 rounded"
                    >
                      {editingMovement?.id === mvmt.id ? (
                        <div className="flex-1 flex gap-2 items-center">
                          <input
                            type="number"
                            value={movementForm.number}
                            onChange={(e) => setMovementForm({ ...movementForm, number: e.target.value })}
                            className="w-16 px-2 py-1 text-sm rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900"
                          />
                          <input
                            type="text"
                            value={movementForm.title}
                            onChange={(e) => setMovementForm({ ...movementForm, title: e.target.value })}
                            placeholder="Title (optional)"
                            className="flex-1 px-2 py-1 text-sm rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900"
                          />
                          <button
                            onClick={() => {
                              setEditingMovement(null);
                              setMovementForm({ number: "", title: "" });
                            }}
                            className="text-xs px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleUpdateMovement}
                            disabled={saving || !movementForm.number}
                            className="text-xs px-2 py-1 rounded bg-blue-600 text-white"
                          >
                            Save
                          </button>
                        </div>
                      ) : (
                        <>
                          <div>
                            <span className="font-mono text-zinc-600 dark:text-zinc-400">
                              {toRoman(mvmt.number)}.
                            </span>{" "}
                            <span className="text-black dark:text-white">
                              {mvmt.title || <span className="text-zinc-400">Untitled</span>}
                            </span>
                          </div>
                          <div className="flex gap-1">
                            <button
                              onClick={() => startEditingMovement(mvmt)}
                              className="text-xs px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-700"
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
              <h4 className="font-medium text-black dark:text-white mb-3">
                Recordings ({selectedWork.recordings.length})
              </h4>
              {selectedWork.recordings.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">No recordings linked yet.</p>
              ) : (
                <div className="space-y-2">
                  {selectedWork.recordings.map((rec) => (
                    <div
                      key={rec.id}
                      className="p-2 bg-zinc-50 dark:bg-zinc-800 rounded text-sm"
                    >
                      <div className="text-black dark:text-white">{rec.albumTitle}</div>
                      <div className="text-xs text-zinc-500">{rec.spotifyAlbumId}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Search and Filters */}
      <div className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Search
            </label>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Title, nickname, or catalog number..."
              className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
            />
          </div>

          <div className="w-48">
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Composer
            </label>
            <select
              value={filterComposerId || ""}
              onChange={(e) => setFilterComposerId(e.target.value ? parseInt(e.target.value) : undefined)}
              className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
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
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Catalog
            </label>
            <input
              type="text"
              value={filterCatalogSystem}
              onChange={(e) => setFilterCatalogSystem(e.target.value)}
              placeholder="BWV, Op., K."
              className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
            />
          </div>

          <button
            onClick={handleSearch}
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {loading && <Spinner />}
            Search
          </button>

          <button
            onClick={() => setShowCreateModal(true)}
            className="px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700"
          >
            Create Work
          </button>
        </div>
      </div>

      {/* Works List */}
      <div className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-4 py-3 bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-lg font-semibold text-black dark:text-white">
            Works ({totalWorks})
          </h2>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner className="w-8 h-8" />
            <span className="ml-2 text-zinc-600 dark:text-zinc-400">Loading...</span>
          </div>
        ) : works.length === 0 ? (
          <div className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
            No works found. Try adjusting your search or create a new work.
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-xs text-zinc-600 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2 text-left">Composer</th>
                <th className="px-4 py-2 text-left">Title</th>
                <th className="px-4 py-2 text-left">Catalog</th>
                <th className="px-4 py-2 text-left">Movements</th>
                <th className="px-4 py-2 text-left">Recordings</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {works.map((work) => (
                <tr key={work.id} className="border-t border-zinc-200 dark:border-zinc-700">
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {work.composerName}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-black dark:text-white">{work.title}</div>
                    {work.nickname && (
                      <div className="text-xs text-zinc-500">&quot;{work.nickname}&quot;</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {work.catalogSystem && work.catalogNumber
                      ? `${work.catalogSystem} ${work.catalogNumber}`
                      : "-"}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {work.movementCount}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {work.recordingCount}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => handleViewWorkDetails(work.id)}
                        disabled={loadingDetails}
                        className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                      >
                        View
                      </button>
                      <button
                        onClick={() => startEditingWork(work)}
                        className="text-xs px-3 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
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
      </div>
    </div>
  );
}
