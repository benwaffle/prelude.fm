'use client';

import { useEffect, useState, useRef } from 'react';
import Image from 'next/image';
import type { SavedTrack, SimplifiedArtist, Track } from '@spotify/web-api-ts-sdk';
import {
  getMatchedTracks,
  getKnownComposerArtists,
  submitToMatchQueue,
  getQueuedTrackIds,
  type MatchedTrack,
} from '@/app/actions/spotify';
import { useSpotifyPlayer } from '@/lib/spotify-player-context';
import { useLikedSongs } from '@/lib/use-liked-songs';
import { MovementRow } from './MovementRow';

interface LikedSongsProps {
  accessToken: string;
}

export function LikedSongs({ accessToken }: LikedSongsProps) {
  const { currentTrack, play } = useSpotifyPlayer();
  const { tracks, loading, error, total } = useLikedSongs(accessToken);
  const [matchedTracks, setMatchedTracks] = useState<MatchedTrack[]>([]);
  const [knownComposerMap, setKnownComposerMap] = useState<Map<string, string>>(new Map()); // artistId -> composerName
  const [checkingMatches, setCheckingMatches] = useState(false);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [unmatchedCollapsed, setUnmatchedCollapsed] = useState(true);
  const [markingTracks, setMarkingTracks] = useState<Set<string>>(new Set());
  const [queuedTrackIds, setQueuedTrackIds] = useState<Set<string>>(new Set());
  const hasCheckedMatches = useRef(false);

  // Check matches when tracks are loaded
  useEffect(() => {
    if (tracks.length === 0 || hasCheckedMatches.current) return;
    hasCheckedMatches.current = true;

    async function checkMatches() {
      setCheckingMatches(true);
      try {
        const trackIds = tracks.map((t) => t.track.id);
        const matched = await getMatchedTracks(trackIds);
        setMatchedTracks(matched);

        // Get all artist IDs from all tracks to check for known composers
        const allArtistIds = new Set<string>();
        for (const { track } of tracks) {
          for (const artist of track.artists) {
            allArtistIds.add(artist.id);
          }
        }

        // Look up known composers
        const knownComposers = await getKnownComposerArtists(Array.from(allArtistIds));
        const composerMap = new Map(knownComposers.map((c) => [c.artistId, c.composerName]));
        setKnownComposerMap(composerMap);

        const queuedIds = await getQueuedTrackIds(trackIds);
        setQueuedTrackIds(new Set(queuedIds));

        // Submit only unmatched tracks that have a known composer artist
        const matchedIds = new Set(matched.map((m) => m.trackId));
        const knownComposerArtistIds = new Set(knownComposers.map((c) => c.artistId));
        const eligibleUnmatchedIds = tracks
          .filter(
            ({ track }) =>
              !matchedIds.has(track.id) &&
              track.artists.some((artist) => knownComposerArtistIds.has(artist.id)),
          )
          .map(({ track }) => track.id);
        if (eligibleUnmatchedIds.length > 0) {
          const result = await submitToMatchQueue(eligibleUnmatchedIds);
          if (result.submitted > 0) {
            console.log(`Submitted ${result.submitted} tracks to match queue`);
          }
        }
      } catch (err) {
        console.error('Failed to check matches:', err);
      } finally {
        setCheckingMatches(false);
      }
    }

    checkMatches();
  }, [tracks]);

  const handleMarkAsClassical = async (trackId: string) => {
    setMarkingTracks((prev) => new Set(prev).add(trackId));
    try {
      const result = await submitToMatchQueue([trackId]);
      if (result.submitted > 0) {
        console.log(`Submitted ${result.submitted} tracks to match queue`);
      }
      setQueuedTrackIds((prev) => {
        const next = new Set(prev);
        next.add(trackId);
        return next;
      });
    } catch (err) {
      console.error('Failed to submit track to match queue:', err);
    } finally {
      setMarkingTracks((prev) => {
        const next = new Set(prev);
        next.delete(trackId);
        return next;
      });
    }
  };

  if (loading && tracks.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-zinc-600 dark:text-zinc-400">Loading your liked songs...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-red-600 dark:text-red-400">Error: {error}</p>
      </div>
    );
  }

  const sortedTracks = [...tracks].sort((a, b) => {
    const dateA = new Date(a.added_at).getTime();
    const dateB = new Date(b.added_at).getTime();
    return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
  });

  // Convert number to roman numeral
  const toRoman = (num: number): string => {
    const romanNumerals: [number, string][] = [
      [10, 'X'],
      [9, 'IX'],
      [5, 'V'],
      [4, 'IV'],
      [1, 'I'],
    ];
    let result = '';
    for (const [value, symbol] of romanNumerals) {
      while (num >= value) {
        result += symbol;
        num -= value;
      }
    }
    return result;
  };

  // Create maps of trackId -> work info, movement number, and movement name
  const trackWorkMap = new Map(matchedTracks.map((m) => [m.trackId, m.work]));
  const trackMovementMap = new Map(matchedTracks.map((m) => [m.trackId, m.movementNumber]));
  const trackMovementNameMap = new Map(
    matchedTracks.map((m) => [
      m.trackId,
      m.movementName
        ? `${toRoman(m.movementNumber)}. ${m.movementName}`
        : `${toRoman(m.movementNumber)}.`,
    ]),
  );
  const matchedTrackIds = new Set(matchedTracks.map((m) => m.trackId));

  // Group matched tracks by work
  const matchedByWork = new Map<number, { work: MatchedTrack['work']; tracks: SavedTrack[] }>();
  for (const likedTrack of sortedTracks) {
    const work = trackWorkMap.get(likedTrack.track.id);
    if (work) {
      const existing = matchedByWork.get(work.id);
      if (existing) {
        existing.tracks.push(likedTrack);
      } else {
        matchedByWork.set(work.id, { work, tracks: [likedTrack] });
      }
    }
  }

  // Helper to get known composer for a track (first matching artist)
  const getTrackComposer = (track: Track): string | null => {
    for (const artist of track.artists) {
      const composerName = knownComposerMap.get(artist.id);
      if (composerName) return composerName;
    }
    return null;
  };

  // Split unmatched tracks into those with known composers and truly unmatched
  const tracksWithKnownComposer: SavedTrack[] = [];
  const unmatchedTracksList: SavedTrack[] = [];

  for (const likedTrack of sortedTracks) {
    if (matchedTrackIds.has(likedTrack.track.id)) continue;

    const composerName = getTrackComposer(likedTrack.track);
    if (composerName) {
      tracksWithKnownComposer.push(likedTrack);
    } else {
      unmatchedTracksList.push(likedTrack);
    }
  }

  // Group tracks with known composers by album
  const knownComposerByAlbum = new Map<
    string,
    { albumName: string; albumImage: string | undefined; tracks: SavedTrack[] }
  >();
  for (const likedTrack of tracksWithKnownComposer) {
    const albumId = likedTrack.track.album.id;
    const existing = knownComposerByAlbum.get(albumId);
    if (existing) {
      existing.tracks.push(likedTrack);
    } else {
      knownComposerByAlbum.set(albumId, {
        albumName: likedTrack.track.album.name,
        albumImage: likedTrack.track.album.images[0]?.url,
        tracks: [likedTrack],
      });
    }
  }

  // Create a flat list of all tracks in display order for queueing
  const allTracksInOrder: Array<{ track: Track; workId?: number; composerName?: string }> = [];

  // Add matched tracks by work (sorted by movement number within each work)
  for (const { work, tracks: workTracks } of matchedByWork.values()) {
    const sortedWorkTracks = [...workTracks].sort((a, b) => {
      const movA = trackMovementMap.get(a.track.id) ?? 0;
      const movB = trackMovementMap.get(b.track.id) ?? 0;
      return movA - movB;
    });
    for (const savedTrack of sortedWorkTracks) {
      allTracksInOrder.push({ track: savedTrack.track, workId: work.id });
    }
  }

  // Add tracks with known composers
  for (const savedTrack of tracksWithKnownComposer) {
    const composerName = getTrackComposer(savedTrack.track)!;
    allTracksInOrder.push({ track: savedTrack.track, composerName });
  }

  // Add unmatched tracks
  for (const savedTrack of unmatchedTracksList) {
    allTracksInOrder.push({ track: savedTrack.track });
  }

  return (
    <div className="w-full">
      {/* Section Header with Editorial Style */}
      <div className="flex items-end justify-between mb-5 pb-3 editorial-border">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--charcoal)' }}>
            Your Collection
          </h2>
          <p className="text-xs tracking-wide" style={{ color: 'var(--warm-gray)' }}>
            {loading ? `Loading ${tracks.length} of ${total}...` : `${tracks.length} recordings`}
          </p>
        </div>
        <button
          onClick={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
          className="text-sm font-medium transition-all duration-300 cursor-pointer px-4 py-2 border"
          style={{
            color: 'var(--charcoal)',
            borderColor: 'var(--border-strong)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent)';
            e.currentTarget.style.color = 'var(--accent)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-strong)';
            e.currentTarget.style.color = 'var(--charcoal)';
          }}
        >
          {sortOrder === 'desc' ? '↓ Newest First' : '↑ Oldest First'}
        </button>
      </div>

      {/* Matched tracks section - grouped by work */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-xs font-medium tracking-widest uppercase" style={{ color: 'var(--warm-gray)', letterSpacing: '0.15em' }}>
            Works
          </h3>
          <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
          <span className="text-xs tabular-nums" style={{ color: 'var(--warm-gray)' }}>
            {checkingMatches
              ? '...'
              : `${matchedByWork.size} ${matchedByWork.size === 1 ? 'work' : 'works'}`}
          </span>
        </div>
        <div className="space-y-px">
          {Array.from(matchedByWork.values()).map(({ work, tracks: workTracks }) => {
            const firstTrack = workTracks[0].track;
            const headerArtists = Array.from(
              new Set(
                firstTrack.artists
                  .filter((a: SimplifiedArtist) => a.name !== work.composerName)
                  .map((a: SimplifiedArtist) => a.name),
              ),
            );

            // Sort tracks by movement number for playback
            const sortedWorkTracks = [...workTracks].sort((a, b) => {
              const movA = trackMovementMap.get(a.track.id) ?? 0;
              const movB = trackMovementMap.get(b.track.id) ?? 0;
              return movA - movB;
            });

            // When clicking work header, queue this work's tracks + up to 50 subsequent tracks
            const firstTrackInWork = sortedWorkTracks[0]?.track;
            const firstTrackIndex = firstTrackInWork
              ? allTracksInOrder.findIndex((t) => t.track.id === firstTrackInWork.id)
              : -1;
            const workAndSubsequentUris =
              firstTrackIndex >= 0
                ? allTracksInOrder
                    .slice(firstTrackIndex, firstTrackIndex + 50)
                    .map((item) => item.track.uri)
                : sortedWorkTracks.map(({ track }) => track.uri);

            const movementCount = workTracks.length;

            return (
              <div
                key={work.id}
                className="border transition-all duration-200"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--warm-white)',
                }}
              >
                {/* Work Header */}
                <div className="flex items-center gap-3 p-2 group hover:bg-cream transition-colors">
                  {/* Album Art */}
                  {firstTrack.album.images[0] && (
                    <button
                      onClick={() => play(workAndSubsequentUris)}
                      className="shrink-0 overflow-hidden shadow-sm transition-transform duration-200 hover:scale-105"
                      style={{ borderRadius: '2px' }}
                    >
                      <Image
                        src={firstTrack.album.images[0].url}
                        alt={firstTrack.album.name}
                        width={56}
                        height={56}
                        className="object-cover"
                      />
                    </button>
                  )}

                  {/* Work Info */}
                  <button
                    onClick={() => play(workAndSubsequentUris)}
                    className="flex-1 min-w-0 text-left cursor-pointer"
                  >
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <p className="text-xs font-bold tracking-wide" style={{ color: 'var(--accent)' }}>
                        {work.composerName}
                      </p>
                      {work.catalogSystem && work.catalogNumber && (
                        <p className="text-xs font-medium" style={{ color: 'var(--warm-gray)' }}>
                          {work.catalogSystem} {work.catalogNumber}
                        </p>
                      )}
                    </div>
                    <p className="text-sm font-medium leading-tight truncate" style={{ color: 'var(--charcoal)' }}>
                      {work.title}
                      {work.nickname && (
                        <span className="italic font-normal ml-1.5" style={{ color: 'var(--warm-gray)' }}>
                          &ldquo;{work.nickname}&rdquo;
                        </span>
                      )}
                    </p>
                    <p className="text-xs truncate mt-0.5" style={{ color: 'var(--warm-gray)' }}>
                      {headerArtists.join(', ')} · {firstTrack.album.name}
                    </p>
                  </button>

                  {/* Movement Count Badge */}
                  {movementCount > 1 && (
                    <div className="shrink-0 px-2 py-1" style={{ color: 'var(--warm-gray)' }}>
                      <span className="text-xs font-medium">{movementCount}</span>
                    </div>
                  )}
                </div>

                {/* Movements List - Always visible for multi-movement works */}
                {movementCount > 1 && (
                  <div className="border-t" style={{ borderColor: 'var(--border)' }}>
                    {[...workTracks]
                      .sort((a, b) => {
                        const movA = trackMovementMap.get(a.track.id) ?? 0;
                        const movB = trackMovementMap.get(b.track.id) ?? 0;
                        return movA - movB;
                      })
                      .map(({ track }) => {
                        // Find this track's position in the global list and queue up to 50 tracks after it
                        const trackIndex = allTracksInOrder.findIndex((t) => t.track.id === track.id);
                        const queueTracks =
                          trackIndex >= 0
                            ? allTracksInOrder
                                .slice(trackIndex + 1, trackIndex + 51)
                                .map((item) => item.track)
                            : [];

                        return (
                          <MovementRow
                            key={track.id}
                            track={track}
                            displayName={trackMovementNameMap.get(track.id) ?? undefined}
                            hideComposer={work.composerName}
                            hideArtwork
                            isPlaying={currentTrack?.id === track.id}
                            queueTracks={queueTracks}
                          />
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}
          {/* Tracks with known composers (but no specific work match) - grouped by album */}
          {Array.from(knownComposerByAlbum.entries()).map(
            ([albumId, { albumName, albumImage, tracks: albumTracks }]) => {
              const firstTrack = albumTracks[0].track;
              const composerName = getTrackComposer(firstTrack)!;
              const trackCount = albumTracks.length;

              // Get URIs for playing
              const firstTrackIndex = allTracksInOrder.findIndex(
                (t) => t.track.id === firstTrack.id,
              );
              const albumAndSubsequentUris =
                firstTrackIndex >= 0
                  ? allTracksInOrder
                      .slice(firstTrackIndex, firstTrackIndex + 50)
                      .map((item) => item.track.uri)
                  : albumTracks.map(({ track }) => track.uri);

              return (
                <div
                  key={albumId}
                  className="border transition-all duration-200"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--warm-white)',
                  }}
                >
                  {/* Album Header */}
                  <div className="flex items-center gap-3 p-2 group hover:bg-cream transition-colors">
                    {/* Album Art */}
                    {albumImage && (
                      <button
                        onClick={() => play(albumAndSubsequentUris)}
                        className="shrink-0 overflow-hidden shadow-sm transition-transform duration-200 hover:scale-105"
                        style={{ borderRadius: '2px' }}
                      >
                        <Image
                          src={albumImage}
                          alt={albumName}
                          width={56}
                          height={56}
                          className="object-cover"
                        />
                      </button>
                    )}

                    {/* Album Info */}
                    <button
                      onClick={() => play(albumAndSubsequentUris)}
                      className="flex-1 min-w-0 text-left cursor-pointer"
                    >
                      <p className="text-xs font-bold tracking-wide mb-0.5" style={{ color: 'var(--accent)' }}>
                        {composerName}
                      </p>
                      <p className="text-sm font-medium leading-tight truncate" style={{ color: 'var(--charcoal)' }}>
                        {albumName}
                      </p>
                      <p className="text-xs truncate mt-0.5" style={{ color: 'var(--warm-gray)' }}>
                        {firstTrack.artists.map((a) => a.name).join(', ')}
                      </p>
                    </button>

                    {/* Track Count Badge */}
                    {trackCount > 1 && (
                      <div className="shrink-0 px-2 py-1" style={{ color: 'var(--warm-gray)' }}>
                        <span className="text-xs font-medium">{trackCount}</span>
                      </div>
                    )}
                  </div>

                  {/* Tracks List - Always visible for multi-track albums */}
                  {trackCount > 1 && (
                    <div className="border-t" style={{ borderColor: 'var(--border)' }}>
                      {[...albumTracks]
                        .sort((a, b) => a.track.track_number - b.track.track_number)
                        .map(({ track }) => {
                          const trackIndex = allTracksInOrder.findIndex(
                            (t) => t.track.id === track.id,
                          );
                          const queueTracks =
                            trackIndex >= 0
                              ? allTracksInOrder
                                  .slice(trackIndex + 1, trackIndex + 51)
                                  .map((item) => item.track)
                              : [];

                          return (
                            <MovementRow
                              key={track.id}
                              track={track}
                              hideComposer={composerName}
                              hideArtwork
                              isPlaying={currentTrack?.id === track.id}
                              queueTracks={queueTracks}
                            />
                          );
                        })}
                    </div>
                  )}
                </div>
              );
            },
          )}
          {!checkingMatches && matchedByWork.size === 0 && tracksWithKnownComposer.length === 0 && (
            <div className="text-center py-12">
              <p className="text-sm" style={{ color: 'var(--warm-gray)' }}>
                No works matched yet. Like some classical tracks on Spotify to get started.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Unmatched tracks section */}
      <div className="pb-24">
        <button
          onClick={() => setUnmatchedCollapsed(!unmatchedCollapsed)}
          className="flex items-center gap-3 mb-4 cursor-pointer group w-full"
        >
          <h3 className="text-xs font-medium tracking-widest uppercase" style={{ color: 'var(--warm-gray)', letterSpacing: '0.15em' }}>
            Unmatched
          </h3>
          <div className="flex-1 h-px" style={{ background: 'var(--border)' }} />
          <span className="text-xs tabular-nums transition-colors duration-200" style={{ color: 'var(--warm-gray)' }}>
            {checkingMatches ? '...' : unmatchedTracksList.length}
          </span>
          <span className="text-xs transition-transform duration-200" style={{ color: 'var(--warm-gray)', transform: unmatchedCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>
            ▸
          </span>
        </button>
        {!unmatchedCollapsed && (
          <div className="grid gap-2">
            {unmatchedTracksList.map(({ track }) => {
              // Find this track's position in the global list and queue up to 50 tracks after it
              const trackIndex = allTracksInOrder.findIndex((t) => t.track.id === track.id);
              const queueTracks =
                trackIndex >= 0
                  ? allTracksInOrder
                      .slice(trackIndex + 1, trackIndex + 51)
                      .map((item) => item.track)
                  : [];
              const isMarking = markingTracks.has(track.id);
              const isQueued = queuedTrackIds.has(track.id);

              return (
                <div key={track.id} className="group relative">
                  <MovementRow
                    track={track}
                    isPlaying={currentTrack?.id === track.id}
                    queueTracks={queueTracks}
                  />
                  <button
                    type="button"
                    onClick={() => handleMarkAsClassical(track.id)}
                    disabled={isMarking || isQueued}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    {isMarking ? 'Marking...' : isQueued ? 'Queued' : 'Mark as classical'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
