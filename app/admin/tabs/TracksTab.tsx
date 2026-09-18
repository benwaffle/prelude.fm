'use client';

import { useState, useEffect } from 'react';
import { getBatchTrackMetadata, type TrackMetadata } from '../actions/spotify-tracks';
import { getMatchQueue, updateMatchQueueStatus } from '../../actions/spotify';
import { AlbumTracksTable } from '../AlbumTracksTable';
import { Spinner } from '../components/Spinner';
import { Notice } from '../components/Notice';

interface AlbumGroup {
  album: {
    id: string;
    name: string;
    release_date: string;
    images: { url: string; width: number; height: number }[];
  };
  tracks: TrackMetadata[];
}

const QUEUE_PAGE_SIZE = 100;

// Regex to detect catalog numbers in track titles
const CATALOG_REGEX = /\b(Op\.?|BWV|K\.?|RV|Hob\.?|D\.?|S\.?|WoO|HWV|WAB|TrV|AV|VB)\s*\d+/i;

const compareTrackOrder = (a: TrackMetadata, b: TrackMetadata) =>
  a.disc_number - b.disc_number || a.track_number - b.track_number;

// Calculate priority score for an album based on its tracks
function getAlbumPriorityScore(tracks: TrackMetadata[]): number {
  let maxScore = 0;
  for (const track of tracks) {
    const hasKnownComposer = track.artists.some((a) => a.inComposersTable);
    const hasCatalog = CATALOG_REGEX.test(track.name);
    const score = (hasKnownComposer ? 2 : 0) + (hasCatalog ? 1 : 0);
    if (score > maxScore) maxScore = score;
    if (maxScore === 3) break; // Max possible score
  }
  return maxScore;
}

function buildAlbumGroups(trackData: TrackMetadata[]): AlbumGroup[] {
  const grouped = trackData.reduce(
    (acc, track) => {
      const albumId = track.album.id;
      if (!acc[albumId]) {
        acc[albumId] = {
          album: {
            id: track.album.id,
            name: track.album.name,
            release_date: track.album.release_date,
            images: track.album.images,
          },
          tracks: [],
        };
      }
      acc[albumId].tracks.push(track);
      return acc;
    },
    {} as Record<string, AlbumGroup>,
  );

  return Object.values(grouped)
    .map((group) => ({
      ...group,
      tracks: group.tracks.sort(compareTrackOrder),
    }))
    .sort((a, b) => getAlbumPriorityScore(b.tracks) - getAlbumPriorityScore(a.tracks));
}

interface TracksTabProps {
  onSwitchTab?: (tab: 'composers' | 'works') => void;
}

export function TracksTab({ onSwitchTab }: TracksTabProps) {
  const [trackUrisInput, setTrackUrisInput] = useState('');
  const [albumGroups, setAlbumGroups] = useState<AlbumGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [queueTotal, setQueueTotal] = useState(0);
  const [queueOffset, setQueueOffset] = useState(0);
  const [loadingQueue, setLoadingQueue] = useState(false);

  // Load queue count on mount
  useEffect(() => {
    loadQueueCount();
  }, []);

  const loadQueueCount = async () => {
    setLoadingQueue(true);
    try {
      const result = await getMatchQueue(0, 0); // Just get count
      setQueueTotal(result.total);
    } catch (err) {
      console.error('Failed to load queue:', err);
    } finally {
      setLoadingQueue(false);
    }
  };

  const handleLoadFromQueue = async (offset = 0) => {
    if (queueTotal === 0) return;

    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    setQueueOffset(offset);

    try {
      const result = await getMatchQueue(QUEUE_PAGE_SIZE, offset);
      setQueueTotal(result.total);

      const trackIds = result.items.map((item) => `spotify:track:${item.spotifyId}`);
      const trackData = await getBatchTrackMetadata(trackIds);
      setAlbumGroups(buildAlbumGroups(trackData));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleTrackSaved = async (trackId: string) => {
    // Update queue status when track is saved
    try {
      await updateMatchQueueStatus([trackId], 'matched');
      setQueueTotal((prev) => Math.max(0, prev - 1));
    } catch (err) {
      console.error('Failed to update queue status:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const uris = trackUrisInput
        .trim()
        .split('\n')
        .filter((line) => line.trim());

      if (uris.length === 0) {
        setError('Please enter at least one Spotify track URI or URL');
        setLoading(false);
        return;
      }

      const trackData = await getBatchTrackMetadata(uris);
      setAlbumGroups(buildAlbumGroups(trackData));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      {/* Help links for creating missing composers/works */}
      {onSwitchTab && (
        <div className="mb-4 p-3 bg-[var(--slip-2)] text-sm text-[var(--ink-2)]">
          <span className="font-medium">Missing data?</span>{' '}
          <button
            onClick={() => onSwitchTab('composers')}
            className="text-[var(--gall)] hover:underline"
          >
            Create a composer
          </button>
          {' or '}
          <button
            onClick={() => onSwitchTab('works')}
            className="text-[var(--gall)] hover:underline"
          >
            create a work
          </button>
          {' in the other tabs.'}
        </div>
      )}

      {/* Match Queue Section */}
      <div className="mb-8 border border-[var(--rule)] bg-[var(--slip)] p-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">Match Queue</h2>
            <p className="text-sm text-[var(--ink-2)]">
              {loadingQueue ? 'Loading...' : `${queueTotal} pending tracks`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadQueueCount}
              disabled={loadingQueue}
              className="px-4 py-2 border border-[var(--rule)] text-[var(--ink-2)] hover:bg-[var(--slip-2)] disabled:opacity-50"
            >
              Refresh
            </button>
            <button
              onClick={() => handleLoadFromQueue(0)}
              disabled={loading || queueTotal === 0}
              className="px-4 py-2 bg-[var(--gall)] text-white hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
            >
              {loading && <Spinner />}
              {loading ? 'Loading...' : `Load ${Math.min(QUEUE_PAGE_SIZE, queueTotal)} Tracks`}
            </button>
          </div>
        </div>
        {/* Pagination controls */}
        {albumGroups.length > 0 && queueTotal > QUEUE_PAGE_SIZE && (
          <div className="flex items-center justify-center gap-2 mt-4 pt-4 border-t border-[var(--rule)]">
            <button
              onClick={() => handleLoadFromQueue(Math.max(0, queueOffset - QUEUE_PAGE_SIZE))}
              disabled={loading || queueOffset === 0}
              className="px-3 py-1 text-sm rounded border border-[var(--rule)] text-[var(--ink-2)] hover:bg-[var(--slip-2)] disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-sm text-[var(--ink-2)]">
              {queueOffset + 1}–{Math.min(queueOffset + QUEUE_PAGE_SIZE, queueTotal)} of{' '}
              {queueTotal}
            </span>
            <button
              onClick={() => handleLoadFromQueue(queueOffset + QUEUE_PAGE_SIZE)}
              disabled={loading || queueOffset + QUEUE_PAGE_SIZE >= queueTotal}
              className="px-3 py-1 text-sm rounded border border-[var(--rule)] text-[var(--ink-2)] hover:bg-[var(--slip-2)] disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}
      </div>

      <div className="mb-4 text-center text-sm text-[var(--faint)]">— or —</div>

      <form onSubmit={handleSubmit} className="mb-8">
        <div className="flex flex-col gap-2 mb-4">
          <label htmlFor="trackUris" className="text-sm font-medium text-[var(--ink-2)]">
            Spotify Track URI(s) or URL(s) (one per line)
          </label>
          <textarea
            id="trackUris"
            value={trackUrisInput}
            onChange={(e) => setTrackUrisInput(e.target.value)}
            placeholder="spotify:track:... or https://open.spotify.com/track/...&#10;One URI/URL per line"
            className="border border-[var(--rule)] bg-[var(--slip)] px-4 py-2 text-[var(--ink)] min-h-[150px]"
            required
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="px-6 py-3 bg-black text-white hover:bg-[var(--slip-2)] dark:bg-white dark:text-black dark:hover:bg-zinc-200 disabled:opacity-50 flex items-center gap-2"
        >
          {loading && <Spinner />}
          {loading ? 'Loading...' : 'Load Tracks'}
        </button>
      </form>

      {error && (
        <Notice variant="error" className="mb-4">
          {error}
        </Notice>
      )}

      {successMessage && (
        <Notice variant="success" className="mb-4">
          {successMessage}
        </Notice>
      )}

      {albumGroups.length > 0 && (
        <div className="space-y-6">
          {albumGroups.map(({ album, tracks }) => (
            <AlbumTracksTable
              key={album.id}
              album={album}
              initialTracks={tracks}
              onError={setError}
              onSuccess={setSuccessMessage}
              onTrackSaved={handleTrackSaved}
            />
          ))}
        </div>
      )}
    </div>
  );
}
