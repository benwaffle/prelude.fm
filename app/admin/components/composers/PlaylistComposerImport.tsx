'use client';

import Image from 'next/image';
import { useState } from 'react';
import { createComposerWithSpotify } from '../../actions/composer-management';
import {
  getPlaylistArtists,
  searchSpotifyPlaylists,
  type PlaylistArtistInfo,
  type SpotifyPlaylistSearchResult,
} from '../../actions/spotify-search';
import { Notice } from '../Notice';
import { Spinner } from '../Spinner';

export function PlaylistComposerImport({
  onChanged,
}: {
  onChanged: (message: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SpotifyPlaylistSearchResult[]>([]);
  const [selected, setSelected] = useState<SpotifyPlaylistSearchResult | null>(null);
  const [artists, setArtists] = useState<PlaylistArtistInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [loadingArtists, setLoadingArtists] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setSelected(null);
    setArtists([]);
    try {
      setResults(await searchSpotifyPlaylists(query));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to search playlists');
    } finally {
      setSearching(false);
    }
  };

  const choose = async (playlist: SpotifyPlaylistSearchResult) => {
    setSelected(playlist);
    setLoadingArtists(true);
    setArtists([]);
    setSelectedIds(new Set());
    setError(null);
    try {
      setArtists(await getPlaylistArtists(playlist.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load playlist artists');
    } finally {
      setLoadingArtists(false);
    }
  };

  const newArtists = artists.filter((artist) => !artist.existingComposerId);
  const selectedArtists = newArtists.filter((artist) => selectedIds.has(artist.id));

  const save = async () => {
    if (selectedArtists.length === 0 || !selected) return;
    setSaving(true);
    setError(null);
    try {
      const outcomes = await Promise.allSettled(
        selectedArtists.map((artist) =>
          createComposerWithSpotify({ name: artist.name, spotifyArtistId: artist.id }),
        ),
      );
      const saved = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
      const failed = outcomes.length - saved;
      setArtists(await getPlaylistArtists(selected.id));
      setSelectedIds(new Set());
      await onChanged(`Saved ${saved} composers from playlist`);
      if (failed > 0) setError(`${failed} composers could not be saved`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to finish the playlist import');
    } finally {
      setSaving(false);
    }
  };

  const toggle = (artistId: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(artistId)) next.delete(artistId);
      else next.add(artistId);
      return next;
    });

  return (
    <section className="overflow-hidden border border-[var(--rule)] bg-[var(--slip)]">
      <header className="border-b border-[var(--rule)] bg-[var(--slip-2)] px-4 py-3">
        <h2 className="text-lg font-semibold text-[var(--ink)]">
          Discover Composers from Playlists
        </h2>
        <p className="text-sm text-[var(--ink-2)]">
          Search classical playlists and extract composer artists
        </p>
      </header>
      <div className="space-y-4 p-4">
        {error && <Notice variant="error">{error}</Notice>}
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && search()}
            placeholder="Search for playlists"
            className="flex-1 border border-[var(--rule)] bg-[var(--slip)] px-3 py-2 text-[var(--ink)] bg-[var(--slip-2)]"
          />
          <button
            onClick={search}
            disabled={!query.trim() || searching}
            className="flex items-center gap-2 bg-[var(--gall)] px-4 py-2 text-white disabled:opacity-50"
          >
            {searching && <Spinner />}
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>

        {!selected && results.length > 0 && (
          <div className="grid max-h-96 grid-cols-1 gap-2 overflow-y-auto md:grid-cols-2">
            {results.map((playlist) => (
              <button
                key={playlist.id}
                onClick={() => choose(playlist)}
                className="flex items-center gap-3 border border-[var(--rule)] p-3 text-left hover:bg-zinc-50 hover:bg-[var(--slip-2)]"
              >
                {playlist.images[0] && (
                  <Image
                    src={playlist.images[0].url}
                    alt=""
                    width={48}
                    height={48}
                    className="h-12 w-12 rounded object-cover"
                  />
                )}
                <span className="min-w-0">
                  <span className="block truncate font-medium text-[var(--ink)]">
                    {playlist.name}
                  </span>
                  <span className="text-xs text-[var(--faint)]">
                    {playlist.trackCount} tracks · by {playlist.owner}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium text-[var(--ink)]">{selected.name}</div>
                <div className="text-sm text-[var(--faint)]">
                  {artists.length} unique artists · {newArtists.length} new
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setSelected(null)}
                  className="border border-[var(--rule)] px-3 py-1.5 text-sm"
                >
                  Back
                </button>
                <button
                  onClick={save}
                  disabled={selectedArtists.length === 0 || saving}
                  className="flex items-center gap-2 bg-[var(--viridian)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
                >
                  {saving && <Spinner />}
                  {saving ? 'Saving...' : `Save ${selectedArtists.length} Composers`}
                </button>
              </div>
            </div>
            {loadingArtists ? (
              <div className="flex justify-center py-8">
                <Spinner className="h-6 w-6" />
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto border border-[var(--rule)]">
                {artists.map((artist) => (
                  <label
                    key={artist.id}
                    className="grid grid-cols-[24px_1fr_auto] items-center gap-3 border-b border-[var(--rule)] px-3 py-2 text-sm last:border-0"
                  >
                    {artist.existingComposerId ? (
                      <span className="text-[var(--faint)]">—</span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(artist.id)}
                        onChange={() => toggle(artist.id)}
                      />
                    )}
                    <span className="text-[var(--ink)]">{artist.name}</span>
                    <span className="text-xs text-[var(--faint)]">
                      {artist.existingComposerId ? 'Exists' : `${artist.trackCount} tracks`}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
