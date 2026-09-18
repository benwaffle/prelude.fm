'use client';

import { useState } from 'react';
import { searchSpotifyArtists, type SpotifyArtistSearchResult } from '../../actions/spotify-search';
import { createComposerWithSpotify } from '../../actions/composer-management';
import { Notice } from '../Notice';
import { Spinner } from '../Spinner';

export function SpotifyArtistSearch({
  existingArtistIds,
  onChanged,
}: {
  existingArtistIds: ReadonlySet<string>;
  onChanged: (message: string) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SpotifyArtistSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await searchSpotifyArtists(query, 10));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to search Spotify artists');
    } finally {
      setSearching(false);
    }
  };

  const add = async (artist: SpotifyArtistSearchResult) => {
    setSaving((current) => new Set(current).add(artist.id));
    setError(null);
    try {
      await createComposerWithSpotify({
        name: artist.name,
        spotifyArtistId: artist.id,
        popularity: artist.popularity ?? null,
        images: artist.images ?? null,
      });
      await onChanged(`Added ${artist.name}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Failed to add ${artist.name}`);
    } finally {
      setSaving((current) => {
        const next = new Set(current);
        next.delete(artist.id);
        return next;
      });
    }
  };

  return (
    <section className="overflow-hidden border border-[var(--rule)] bg-[var(--slip)]">
      <header className="border-b border-[var(--rule)] bg-[var(--slip-2)] px-4 py-3">
        <h2 className="text-lg font-semibold text-[var(--ink)]">Search Spotify Artists</h2>
        <p className="text-sm text-[var(--ink-2)]">
          Find artists on Spotify and add them as composers
        </p>
      </header>
      <div className="space-y-4 p-4">
        {error && <Notice variant="error">{error}</Notice>}
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && search()}
            placeholder="Search Spotify artists..."
            className="flex-1 border border-[var(--rule)] bg-[var(--slip)] px-3 py-2 text-[var(--ink)] bg-[var(--slip-2)]"
          />
          <button
            onClick={search}
            disabled={!query.trim() || searching}
            className="flex items-center gap-2 bg-[var(--gall)] px-4 py-2 text-white hover:opacity-90 disabled:opacity-50"
          >
            {searching && <Spinner />}
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
        {results.map((artist) => {
          const isExisting = existingArtistIds.has(artist.id);
          const isSaving = saving.has(artist.id);
          const image = artist.images.at(-1)?.url;
          return (
            <div
              key={artist.id}
              className="flex items-center justify-between gap-4 border border-[var(--rule)] p-3"
            >
              <div className="flex items-center gap-3">
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={image} alt="" className="h-10 w-10 rounded-full object-cover" />
                ) : (
                  <span className="h-10 w-10 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                )}
                <div>
                  <div className="font-medium text-[var(--ink)]">{artist.name}</div>
                  <div className="text-xs text-[var(--faint)]">Popularity: {artist.popularity}</div>
                </div>
              </div>
              <button
                onClick={() => add(artist)}
                disabled={isExisting || isSaving}
                className="flex items-center gap-2 bg-[var(--viridian)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                {isSaving && <Spinner />}
                {isSaving ? 'Adding...' : isExisting ? 'Already Added' : 'Add Composer'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
