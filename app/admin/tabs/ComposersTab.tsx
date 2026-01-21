'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import {
  getComposersWithStats,
  updateComposerDetails,
  createComposerWithSpotify,
} from '../actions/composer-management';
import type { ComposerRow } from '../actions/schema-types';
import {
  searchSpotifyArtistForImport,
  searchSpotifyArtists,
  refreshSpotifyArtistMetadataMissing,
  searchSpotifyPlaylists,
  getPlaylistArtists,
  type SpotifyArtistSearchResult,
  type SpotifyPlaylistSearchResult,
  type PlaylistArtistInfo,
} from '../actions/spotify-search';
import { Spinner } from '../components/Spinner';
import { Notice } from '../components/Notice';
import { Modal } from '../components/Modal';

type ComposerWithStats = ComposerRow & {
  workCount: number;
  spotifyImages?: { url: string; width: number; height: number }[] | null;
  spotifyPopularity?: number | null;
};

export function ComposersTab() {
  const [composers, setComposers] = useState<ComposerWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Edit state
  const [editingComposer, setEditingComposer] = useState<ComposerRow | null>(null);
  const [editForm, setEditForm] = useState({
    name: '',
    birthYear: '',
    deathYear: '',
    biography: '',
  });

  // Saving states
  const [saving, setSaving] = useState(false);

  // Import from JSON state
  const [jsonInput, setJsonInput] = useState('');
  const [importResults, setImportResults] = useState<
    Array<{
      input: { name: string; birthYear?: number; deathYear?: number };
      results: SpotifyArtistSearchResult[];
      existingComposerId?: number;
      selectedArtistId?: string;
    }>
  >([]);
  const [searchingSpotify, setSearchingSpotify] = useState(false);
  const [savingImport, setSavingImport] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });

  // Spotify artist search state
  const [spotifySearchQuery, setSpotifySearchQuery] = useState('');
  const [spotifySearchResults, setSpotifySearchResults] = useState<SpotifyArtistSearchResult[]>([]);
  const [searchingSpotifyArtists, setSearchingSpotifyArtists] = useState(false);
  const [savingSpotifyArtists, setSavingSpotifyArtists] = useState<Set<string>>(new Set());

  // Playlist search state
  const [playlistSearchQuery, setPlaylistSearchQuery] = useState('');
  const [playlistResults, setPlaylistResults] = useState<SpotifyPlaylistSearchResult[]>([]);
  const [searchingPlaylists, setSearchingPlaylists] = useState(false);
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylistSearchResult | null>(
    null,
  );
  const [playlistArtists, setPlaylistArtists] = useState<PlaylistArtistInfo[]>([]);
  const [loadingPlaylistArtists, setLoadingPlaylistArtists] = useState(false);
  const [selectedPlaylistArtists, setSelectedPlaylistArtists] = useState<Set<string>>(new Set());
  const [savingPlaylistComposers, setSavingPlaylistComposers] = useState(false);
  const [refreshingArtists, setRefreshingArtists] = useState(false);
  const [composerSortBy, setComposerSortBy] = useState<'name' | 'popularity'>('name');
  const [composerSortDir, setComposerSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const composersResult = await getComposersWithStats();
      setComposers(composersResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateComposer = async () => {
    if (!editingComposer || !editForm.name.trim()) return;

    setSaving(true);
    setError(null);

    try {
      await updateComposerDetails(editingComposer.id, {
        name: editForm.name.trim(),
        birthYear: editForm.birthYear ? parseInt(editForm.birthYear) : null,
        deathYear: editForm.deathYear ? parseInt(editForm.deathYear) : null,
        biography: editForm.biography.trim() || null,
      });

      setSuccessMessage(`Updated composer: ${editForm.name}`);
      setEditingComposer(null);
      setEditForm({ name: '', birthYear: '', deathYear: '', biography: '' });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update composer');
    } finally {
      setSaving(false);
    }
  };

  const startEditingComposer = (comp: ComposerWithStats) => {
    setEditingComposer(comp);
    setEditForm({
      name: comp.name,
      birthYear: comp.birthYear?.toString() || '',
      deathYear: comp.deathYear?.toString() || '',
      biography: comp.biography || '',
    });
  };

  // Import from JSON handlers
  const handleSearchFromJson = async () => {
    try {
      const parsed = JSON.parse(jsonInput) as Array<{
        name: string;
        born?: number;
        died?: number;
        birthYear?: number;
        deathYear?: number;
      }>;
      if (!Array.isArray(parsed)) {
        setError('JSON must be an array of composers');
        return;
      }

      const names = parsed.map((c) => ({
        name: c.name,
        birthYear: c.born ?? c.birthYear,
        deathYear: c.died ?? c.deathYear,
      }));

      setSearchingSpotify(true);
      setError(null);
      setImportProgress({ current: 0, total: names.length });
      setImportResults([]);

      let nonExistingCount = 0;
      let processedCount = 0;

      for (const input of names) {
        if (nonExistingCount >= 20) {
          break;
        }
        const result = await searchSpotifyArtistForImport(input);
        processedCount++;
        if (result.existingComposerId) {
          setImportProgress({ current: processedCount, total: names.length });
          continue;
        }

        nonExistingCount++;
        const withSelection = {
          ...result,
          selectedArtistId:
            result.results.length > 0 &&
            result.results[0].name.toLowerCase() === result.input.name.toLowerCase()
              ? result.results[0].id
              : undefined,
        };
        setImportResults((prev) => [...prev, withSelection]);
        setImportProgress({ current: processedCount, total: names.length });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
    } finally {
      setSearchingSpotify(false);
    }
  };

  const handleSelectArtist = (index: number, artistId: string | undefined) => {
    setImportResults((prev) =>
      prev.map((r, i) => (i === index ? { ...r, selectedArtistId: artistId } : r)),
    );
  };

  const handleSaveSelectedComposers = async () => {
    const toSave = importResults.filter((r) => r.selectedArtistId && !r.existingComposerId);
    if (toSave.length === 0) {
      setError('No composers selected to save');
      return;
    }

    setSavingImport(true);
    setError(null);
    setImportProgress({ current: 0, total: toSave.length });

    let saved = 0;
    for (const item of toSave) {
      try {
        const selectedArtist = item.results.find((r) => r.id === item.selectedArtistId);
        await createComposerWithSpotify({
          name: item.input.name,
          spotifyArtistId: item.selectedArtistId!,
          birthYear: item.input.birthYear,
          deathYear: item.input.deathYear,
          popularity: selectedArtist?.popularity ?? null,
          images: selectedArtist?.images ?? null,
        });
        saved++;
        setImportProgress({ current: saved, total: toSave.length });
      } catch (err) {
        console.error(`Failed to save ${item.input.name}:`, err);
      }
    }

    setSuccessMessage(`Saved ${saved} composers`);
    setImportResults([]);
    setJsonInput('');
    await loadData();
    setSavingImport(false);
  };

  const selectedCount = importResults.filter(
    (r) => r.selectedArtistId && !r.existingComposerId,
  ).length;
  const existingCount = importResults.filter((r) => r.existingComposerId).length;
  const existingComposerArtistIds = new Set(
    composers.map((comp) => comp.spotifyArtistId).filter((id): id is string => Boolean(id)),
  );

  // Spotify artist search handlers
  const handleSearchSpotifyArtists = async () => {
    if (!spotifySearchQuery.trim()) return;

    setSearchingSpotifyArtists(true);
    setError(null);
    setSpotifySearchResults([]);

    try {
      const results = await searchSpotifyArtists(spotifySearchQuery, 10);
      setSpotifySearchResults(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search Spotify artists');
    } finally {
      setSearchingSpotifyArtists(false);
    }
  };

  const handleAddSpotifyArtist = async (artist: SpotifyArtistSearchResult) => {
    setSavingSpotifyArtists((prev) => new Set(prev).add(artist.id));
    setError(null);

    try {
      await createComposerWithSpotify({
        name: artist.name,
        spotifyArtistId: artist.id,
        popularity: artist.popularity ?? null,
        images: artist.images ?? null,
      });
      setSuccessMessage(`Added ${artist.name}`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to add ${artist.name}`);
    } finally {
      setSavingSpotifyArtists((prev) => {
        const next = new Set(prev);
        next.delete(artist.id);
        return next;
      });
    }
  };

  // Playlist search handlers
  const handleSearchPlaylists = async () => {
    if (!playlistSearchQuery.trim()) return;

    setSearchingPlaylists(true);
    setError(null);
    setPlaylistResults([]);
    setSelectedPlaylist(null);
    setPlaylistArtists([]);

    try {
      const results = await searchSpotifyPlaylists(playlistSearchQuery);
      setPlaylistResults(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search playlists');
    } finally {
      setSearchingPlaylists(false);
    }
  };

  const handleSelectPlaylist = async (playlist: SpotifyPlaylistSearchResult) => {
    setSelectedPlaylist(playlist);
    setLoadingPlaylistArtists(true);
    setPlaylistArtists([]);
    setSelectedPlaylistArtists(new Set());
    setError(null);

    try {
      const artists = await getPlaylistArtists(playlist.id);
      setPlaylistArtists(artists);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load playlist artists');
    } finally {
      setLoadingPlaylistArtists(false);
    }
  };

  const togglePlaylistArtist = (artistId: string) => {
    setSelectedPlaylistArtists((prev) => {
      const next = new Set(prev);
      if (next.has(artistId)) {
        next.delete(artistId);
      } else {
        next.add(artistId);
      }
      return next;
    });
  };

  const handleSavePlaylistComposers = async () => {
    const toSave = playlistArtists.filter(
      (a) => selectedPlaylistArtists.has(a.id) && !a.existingComposerId,
    );
    if (toSave.length === 0) return;

    setSavingPlaylistComposers(true);
    setError(null);

    let saved = 0;
    for (const artist of toSave) {
      try {
        await createComposerWithSpotify({
          name: artist.name,
          spotifyArtistId: artist.id,
        });
        saved++;
      } catch (err) {
        console.error(`Failed to save ${artist.name}:`, err);
      }
    }

    setSuccessMessage(`Saved ${saved} composers from playlist`);
    setSelectedPlaylistArtists(new Set());
    // Refresh the playlist artists to update "exists" status
    if (selectedPlaylist) {
      const refreshed = await getPlaylistArtists(selectedPlaylist.id);
      setPlaylistArtists(refreshed);
    }
    await loadData();
    setSavingPlaylistComposers(false);
  };

  const handleRefreshArtistMetadata = async () => {
    setRefreshingArtists(true);
    setError(null);

    try {
      const result = await refreshSpotifyArtistMetadataMissing();
      setSuccessMessage(`Refreshed ${result.updated}/${result.total} artists`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh artist metadata');
    } finally {
      setRefreshingArtists(false);
    }
  };

  const playlistNewArtistsCount = playlistArtists.filter((a) => !a.existingComposerId).length;
  const playlistSelectedNewCount = playlistArtists.filter(
    (a) => selectedPlaylistArtists.has(a.id) && !a.existingComposerId,
  ).length;

  const sortedComposers = [...composers].sort((a, b) => {
    if (composerSortBy === 'popularity') {
      const aVal = a.spotifyPopularity ?? -1;
      const bVal = b.spotifyPopularity ?? -1;
      return composerSortDir === 'asc' ? aVal - bVal : bVal - aVal;
    }
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    return composerSortDir === 'asc' ? aName.localeCompare(bName) : bName.localeCompare(aName);
  });

  const togglePopularitySort = () => {
    if (composerSortBy === 'popularity') {
      setComposerSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setComposerSortBy('popularity');
      setComposerSortDir('desc');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner className="w-8 h-8" />
        <span className="ml-2 text-zinc-600 dark:text-zinc-400">Loading...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {error && <Notice variant="error">{error}</Notice>}

      {successMessage && <Notice variant="success">{successMessage}</Notice>}

      {/* Edit Composer Modal */}
      {editingComposer && (
        <Modal
          isOpen={Boolean(editingComposer)}
          onClose={() => setEditingComposer(null)}
          className="max-w-md"
        >
          <h3 className="text-lg font-semibold text-black dark:text-white mb-4">Edit Composer</h3>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Name *
              </label>
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  Birth Year
                </label>
                <input
                  type="number"
                  value={editForm.birthYear}
                  onChange={(e) => setEditForm({ ...editForm, birthYear: e.target.value })}
                  placeholder="1770"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                  Death Year
                </label>
                <input
                  type="number"
                  value={editForm.deathYear}
                  onChange={(e) => setEditForm({ ...editForm, deathYear: e.target.value })}
                  placeholder="1827"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Biography
              </label>
              <textarea
                value={editForm.biography}
                onChange={(e) => setEditForm({ ...editForm, biography: e.target.value })}
                rows={3}
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <button
              onClick={() => setEditingComposer(null)}
              className="px-4 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={handleUpdateComposer}
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {saving && <Spinner />}
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {/* Playlist Search Section */}
      <div className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-4 py-3 bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-lg font-semibold text-black dark:text-white">
            Discover Composers from Playlists
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Search for classical playlists and extract composer artists
          </p>
        </div>

        <div className="p-4 space-y-4">
          {/* Search bar */}
          <div className="flex gap-2">
            <input
              type="text"
              value={playlistSearchQuery}
              onChange={(e) => setPlaylistSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearchPlaylists()}
              placeholder="Search for playlists (e.g., 'classical music', 'bach', 'baroque')"
              className="flex-1 px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
            />
            <button
              onClick={handleSearchPlaylists}
              disabled={!playlistSearchQuery.trim() || searchingPlaylists}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {searchingPlaylists && <Spinner />}
              {searchingPlaylists ? 'Searching...' : 'Search'}
            </button>
          </div>

          {/* Playlist results */}
          {playlistResults.length > 0 && !selectedPlaylist && (
            <div className="space-y-2">
              <div className="text-sm text-zinc-600 dark:text-zinc-400">
                Found {playlistResults.length} playlists
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-96 overflow-y-auto">
                {playlistResults.map((playlist) => (
                  <button
                    key={playlist.id}
                    onClick={() => handleSelectPlaylist(playlist)}
                    className="flex items-center gap-3 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-left"
                  >
                    {playlist.images[0] && (
                      <Image
                        src={playlist.images[0].url}
                        alt=""
                        width={playlist.images[0].width ?? 48}
                        height={playlist.images[0].height ?? 48}
                        className="w-12 h-12 rounded"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-black dark:text-white truncate">
                        {playlist.name}
                      </div>
                      <div className="text-xs text-zinc-500">
                        {playlist.trackCount} tracks · by {playlist.owner}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Selected playlist artists */}
          {selectedPlaylist && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-black dark:text-white">
                    {selectedPlaylist.name}
                  </div>
                  <div className="text-sm text-zinc-500">
                    {playlistArtists.length} unique artists · {playlistNewArtistsCount} new
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setSelectedPlaylist(null);
                      setPlaylistArtists([]);
                      setSelectedPlaylistArtists(new Set());
                    }}
                    className="px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    Back to Results
                  </button>
                  <button
                    onClick={handleSavePlaylistComposers}
                    disabled={playlistSelectedNewCount === 0 || savingPlaylistComposers}
                    className="px-3 py-1.5 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    {savingPlaylistComposers && <Spinner />}
                    {savingPlaylistComposers
                      ? 'Saving...'
                      : `Save ${playlistSelectedNewCount} Composers`}
                  </button>
                </div>
              </div>

              {loadingPlaylistArtists ? (
                <div className="flex items-center justify-center py-8">
                  <Spinner className="w-6 h-6" />
                  <span className="ml-2 text-zinc-600 dark:text-zinc-400">Loading artists...</span>
                </div>
              ) : (
                <div className="max-h-96 overflow-y-auto border border-zinc-200 dark:border-zinc-700 rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-50 dark:bg-zinc-800/50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left w-12">
                          <input
                            type="checkbox"
                            checked={
                              playlistArtists.filter((a) => !a.existingComposerId).length > 0 &&
                              playlistArtists
                                .filter((a) => !a.existingComposerId)
                                .every((a) => selectedPlaylistArtists.has(a.id))
                            }
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedPlaylistArtists(
                                  new Set(
                                    playlistArtists
                                      .filter((a) => !a.existingComposerId)
                                      .map((a) => a.id),
                                  ),
                                );
                              } else {
                                setSelectedPlaylistArtists(new Set());
                              }
                            }}
                            className="rounded"
                          />
                        </th>
                        <th className="px-3 py-2 text-left">Artist</th>
                        <th className="px-3 py-2 text-left">Tracks</th>
                        <th className="px-3 py-2 text-left">Sample Track</th>
                        <th className="px-3 py-2 text-left">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {playlistArtists.map((artist) => (
                        <tr
                          key={artist.id}
                          className="border-t border-zinc-200 dark:border-zinc-700"
                        >
                          <td className="px-3 py-2">
                            {artist.existingComposerId ? (
                              <span className="text-zinc-400">—</span>
                            ) : (
                              <input
                                type="checkbox"
                                checked={selectedPlaylistArtists.has(artist.id)}
                                onChange={() => togglePlaylistArtist(artist.id)}
                                className="rounded"
                              />
                            )}
                          </td>
                          <td className="px-3 py-2 text-black dark:text-white">{artist.name}</td>
                          <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                            {artist.trackCount}
                          </td>
                          <td className="px-3 py-2 text-zinc-500 text-xs truncate max-w-xs">
                            {artist.sampleTrack}
                          </td>
                          <td className="px-3 py-2">
                            {artist.existingComposerId ? (
                              <span className="text-xs px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                                Exists
                              </span>
                            ) : (
                              <span className="text-xs px-2 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                                New
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Spotify Artist Search Section */}
      <div className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-4 py-3 bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-lg font-semibold text-black dark:text-white">
            Search Spotify Artists
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Find artists on Spotify and add them as composers
          </p>
        </div>

        <div className="p-4 space-y-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={spotifySearchQuery}
              onChange={(e) => setSpotifySearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearchSpotifyArtists()}
              placeholder="Search Spotify artists..."
              className="flex-1 px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white"
            />
            <button
              onClick={handleSearchSpotifyArtists}
              disabled={!spotifySearchQuery.trim() || searchingSpotifyArtists}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {searchingSpotifyArtists && <Spinner />}
              {searchingSpotifyArtists ? 'Searching...' : 'Search'}
            </button>
          </div>

          {spotifySearchResults.length > 0 && (
            <div className="space-y-2">
              {spotifySearchResults.map((artist) => {
                const imageUrl = artist.images?.[artist.images.length - 1]?.url;
                const isSaving = savingSpotifyArtists.has(artist.id);
                const isExisting = existingComposerArtistIds.has(artist.id);
                return (
                  <div
                    key={artist.id}
                    className="flex items-center justify-between gap-4 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700"
                  >
                    <div className="flex items-center gap-3">
                      {imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={imageUrl}
                          alt=""
                          className="w-10 h-10 rounded-full object-cover"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                      )}
                      <div>
                        <div className="text-black dark:text-white font-medium">{artist.name}</div>
                        <div className="text-xs text-zinc-500">Popularity: {artist.popularity}</div>
                      </div>
                    </div>
                    {isExisting && (
                      <span className="text-xs px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                        In DB
                      </span>
                    )}
                    <button
                      onClick={() => handleAddSpotifyArtist(artist)}
                      disabled={isSaving || isExisting}
                      className="px-3 py-1.5 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                    >
                      {isSaving && <Spinner />}
                      {isSaving ? 'Adding...' : isExisting ? 'Already Added' : 'Add Composer'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Import from JSON Section */}
      <div className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-4 py-3 bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-lg font-semibold text-black dark:text-white">
            Import Composers from JSON
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Paste JSON array with composer names, search Spotify, and save
          </p>
        </div>

        <div className="p-4 space-y-4">
          {importResults.length === 0 ? (
            <>
              <textarea
                value={jsonInput}
                onChange={(e) => setJsonInput(e.target.value)}
                placeholder='[{"name": "Johann Sebastian Bach", "born": 1685, "died": 1750}, ...]'
                rows={6}
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-black dark:text-white font-mono text-sm"
              />
              <button
                onClick={handleSearchFromJson}
                disabled={!jsonInput.trim() || searchingSpotify}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {searchingSpotify && <Spinner />}
                {searchingSpotify ? `Searching Spotify...` : 'Search Spotify for Artists'}
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm text-zinc-600 dark:text-zinc-400">
                  {importResults.length} composers · {selectedCount} selected · {existingCount}{' '}
                  already exist
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setImportResults([])}
                    className="px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    Clear
                  </button>
                  <button
                    onClick={handleSaveSelectedComposers}
                    disabled={selectedCount === 0 || savingImport}
                    className="px-3 py-1.5 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    {savingImport && <Spinner />}
                    {savingImport
                      ? `Saving ${importProgress.current}/${importProgress.total}...`
                      : `Save ${selectedCount} Composers`}
                  </button>
                </div>
              </div>

              <div className="max-h-96 overflow-y-auto border border-zinc-200 dark:border-zinc-700 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 dark:bg-zinc-800/50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">Composer</th>
                      <th className="px-3 py-2 text-left">Spotify Match</th>
                      <th className="px-3 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResults.map((item, index) => (
                      <tr key={index} className="border-t border-zinc-200 dark:border-zinc-700">
                        <td className="px-3 py-2">
                          <div className="text-black dark:text-white">{item.input.name}</div>
                          {(item.input.birthYear || item.input.deathYear) && (
                            <div className="text-xs text-zinc-500">
                              {item.input.birthYear}–{item.input.deathYear}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {item.existingComposerId ? (
                            <span className="text-zinc-500">—</span>
                          ) : item.results.length === 0 ? (
                            <span className="text-zinc-500 italic">No results</span>
                          ) : (
                            <div className="space-y-2">
                              <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                                <input
                                  type="radio"
                                  name={`import-${index}`}
                                  checked={!item.selectedArtistId}
                                  onChange={() => handleSelectArtist(index, undefined)}
                                />
                                <span>Don&apos;t import</span>
                              </label>
                              {item.results.map((artist) => {
                                const imageUrl = artist.images?.[artist.images.length - 1]?.url;
                                return (
                                  <label
                                    key={artist.id}
                                    className="flex items-center gap-2 text-sm"
                                  >
                                    <input
                                      type="radio"
                                      name={`import-${index}`}
                                      checked={item.selectedArtistId === artist.id}
                                      onChange={() => handleSelectArtist(index, artist.id)}
                                    />
                                    {imageUrl ? (
                                      // eslint-disable-next-line @next/next/no-img-element
                                      <img
                                        src={imageUrl}
                                        alt=""
                                        className="w-8 h-8 rounded-full object-cover"
                                      />
                                    ) : (
                                      <div className="w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                                    )}
                                    <span className="text-black dark:text-white">
                                      {artist.name}{' '}
                                      <span className="text-zinc-500">
                                        (pop: {artist.popularity})
                                      </span>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {item.existingComposerId ? (
                            <span className="text-xs px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                              Exists
                            </span>
                          ) : item.selectedArtistId ? (
                            <span className="text-xs px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
                              Selected
                            </span>
                          ) : (
                            <span className="text-xs px-2 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                              Skip
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Existing Composers Section */}
      <div className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-4 py-3 bg-zinc-100 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-black dark:text-white">
                Composers ({composers.length})
              </h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                All composers in the database
              </p>
            </div>
            <button
              onClick={handleRefreshArtistMetadata}
              disabled={refreshingArtists}
              className="px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
            >
              {refreshingArtists && <Spinner />}
              {refreshingArtists ? 'Refreshing...' : 'Refresh missing Spotify metadata'}
            </button>
          </div>
        </div>

        {composers.length === 0 ? (
          <div className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
            No composers yet. Create one from an unlinked artist above.
          </div>
        ) : (
          <div className="max-h-[520px] overflow-y-auto">
            <table className="w-full">
              <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-xs text-zinc-600 dark:text-zinc-400 sticky top-0">
                <tr>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">Years</th>
                  <th className="px-4 py-2 text-left">
                    <button
                      type="button"
                      onClick={togglePopularitySort}
                      className="inline-flex items-center gap-1 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200"
                    >
                      Popularity
                      {composerSortBy === 'popularity' && (
                        <span>{composerSortDir === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </button>
                  </th>
                  <th className="px-4 py-2 text-left">Works</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {sortedComposers.map((comp) => (
                  <tr key={comp.id} className="border-t border-zinc-200 dark:border-zinc-700">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {comp.spotifyImages?.length ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={comp.spotifyImages[comp.spotifyImages.length - 1]?.url}
                            alt=""
                            className="w-10 h-10 rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                        )}
                        <div>
                          <div className="text-black dark:text-white font-medium">{comp.name}</div>
                          {comp.spotifyArtistId && (
                            <div className="text-xs text-zinc-500">
                              Spotify:{' '}
                              <a
                                href={`https://open.spotify.com/artist/${comp.spotifyArtistId}`}
                                target="_blank"
                                rel="noreferrer"
                                className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
                              >
                                {comp.spotifyArtistId}
                              </a>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {comp.birthYear || comp.deathYear
                        ? `${comp.birthYear || '?'}–${comp.deathYear || '?'}`
                        : '-'}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {comp.spotifyPopularity ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{comp.workCount}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => startEditingComposer(comp)}
                        className="text-xs px-3 py-1 rounded border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
