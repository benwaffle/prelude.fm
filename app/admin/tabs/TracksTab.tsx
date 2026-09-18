'use client';

import { useState, useEffect } from 'react';
import { getBatchTrackMetadata, type TrackMetadata } from '../actions/spotify-tracks';
import { getMatchQueue, updateMatchQueueStatus } from '../../actions/spotify';
import { AlbumTracksTable } from '../AlbumTracksTable';
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
    <div className="flex flex-col gap-5 pb-16">
      <section className="panel">
        <div className="toolbar">
          <span className="panel-title">Match queue</span>
          <span className="mono text-[15px] text-[var(--gall)]">
            {loadingQueue ? '…' : queueTotal.toLocaleString()}
          </span>
          <span className="text-[var(--ink-2)]">tracks waiting</span>
          <span className="ml-auto flex gap-2">
            <button onClick={loadQueueCount} disabled={loadingQueue} className="act">
              Refresh
            </button>
            <button
              onClick={() => handleLoadFromQueue(0)}
              disabled={loading || queueTotal === 0}
              className="act"
              data-variant="primary"
            >
              {loading ? 'Loading…' : `Load ${Math.min(QUEUE_PAGE_SIZE, queueTotal)}`}
            </button>
          </span>
        </div>

        {albumGroups.length > 0 && queueTotal > QUEUE_PAGE_SIZE && (
          <div className="toolbar">
            <button
              onClick={() => handleLoadFromQueue(Math.max(0, queueOffset - QUEUE_PAGE_SIZE))}
              disabled={loading || queueOffset === 0}
              className="act"
            >
              Previous
            </button>
            <span className="mono text-[11px] text-[var(--ink-2)]">
              {queueOffset + 1}–{Math.min(queueOffset + QUEUE_PAGE_SIZE, queueTotal)} of{' '}
              {queueTotal.toLocaleString()}
            </span>
            <button
              onClick={() => handleLoadFromQueue(queueOffset + QUEUE_PAGE_SIZE)}
              disabled={loading || queueOffset + QUEUE_PAGE_SIZE >= queueTotal}
              className="act"
            >
              Next
            </button>
          </div>
        )}
      </section>

      <details className="fold">
        <summary>Load specific tracks</summary>
        <div className="fold-body">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <label htmlFor="trackUris" className="text-[var(--ink-2)]">
              Paste Spotify track links or URIs, one per line.
            </label>
            <textarea
              id="trackUris"
              value={trackUrisInput}
              onChange={(e) => setTrackUrisInput(e.target.value)}
              placeholder="https://open.spotify.com/track/…"
              className="min-h-[110px]"
              required
            />
            <button
              type="submit"
              disabled={loading}
              className="act self-start"
              data-variant="primary"
            >
              {loading ? 'Loading…' : 'Load tracks'}
            </button>
          </form>
        </div>
      </details>

      {onSwitchTab && (
        <p className="text-[11px] text-[var(--faint)]">
          Composer or work missing?{' '}
          <button onClick={() => onSwitchTab('composers')} className="text-[var(--gall)] underline">
            Add a composer
          </button>{' '}
          or{' '}
          <button onClick={() => onSwitchTab('works')} className="text-[var(--gall)] underline">
            add a work
          </button>
          .
        </p>
      )}

      {error && <Notice variant="error">{error}</Notice>}
      {successMessage && <Notice variant="success">{successMessage}</Notice>}

      {albumGroups.length > 0 && (
        <div className="flex flex-col gap-5">
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
