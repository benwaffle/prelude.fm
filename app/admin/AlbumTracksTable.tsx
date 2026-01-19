import { useState, useMemo, type ReactNode } from "react";
import Image from "next/image";
import {
  getBatchTrackMetadata,
  getAlbumTrackIds,
  type TrackMetadata,
} from "./actions/spotify-tracks";
import {
  saveTrackWithMetadata,
  deleteTrackMetadata,
  checkWorksExist,
} from "./actions/ingest-metadata";
import { parseAlbumTracks, type ClassicalMetadata } from "./parse-track";
import { Spinner } from "./components/Spinner";
import { toRoman } from "./lib/format";

interface TrackData extends TrackMetadata {
  parsed?: ClassicalMetadata;
}

interface AlbumTracksTableProps {
  album: {
    id: string;
    name: string;
    release_date: string;
    images: { url: string; width: number; height: number }[];
  };
  initialTracks: TrackData[];
  onError?: (error: string) => void;
  onSuccess?: (message: string) => void;
  onTrackSaved?: (trackId: string) => void;
}

interface EditableMetadata {
  composerName: string;
  catalogSystem: string;
  catalogNumber: string;
  nickname: string;
  formalName: string;
  movement: number | null;
  movementName: string;
}

const compareTrackOrder = (a: TrackData, b: TrackData) =>
  a.disc_number - b.disc_number || a.track_number - b.track_number;

export function AlbumTracksTable({ album, initialTracks, onError, onSuccess, onTrackSaved }: AlbumTracksTableProps) {
  const [tracks, setTracks] = useState<TrackData[]>(initialTracks);
  const [analyzing, setAnalyzing] = useState(false);
  const [loadingAlbum, setLoadingAlbum] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [savingTracks, setSavingTracks] = useState<Set<string>>(new Set());
  const [editedMetadata, setEditedMetadata] = useState<Record<string, EditableMetadata>>({});
  // Record of "CatalogSystem:CatalogNumber" -> { workId, movements: { number, title }[] }
  const [existingWorks, setExistingWorks] = useState<Record<string, { workId: number; movements: { number: number; title: string | null }[] }>>({});

  // Sort tracks by album order (disc number, then track number)
  const sortedTracks = useMemo(() => {
    return [...tracks].sort(compareTrackOrder);
  }, [tracks]);

  // Helper to check if track has metadata (linked to work/movement)
  const hasMetadata = (track: TrackData) => {
    return track.dbData?.trackMovements && track.dbData.trackMovements.length > 0;
  };

  // Get editable metadata for a track (from edits > parsed > db)
  const getEditableMetadata = (track: TrackData): EditableMetadata => {
    const edited = editedMetadata[track.id];
    if (edited) return edited;

    const parsed = track.parsed;
    const dbComposer = track.dbData?.composers?.[0];
    const dbWork = track.dbData?.works?.[0];
    const dbMovement = track.dbData?.movements?.[0];

    const composerName = parsed?.composerName || dbComposer?.name || "";
    const workInfo = parsed
      ? {
          catalogSystem: parsed.catalogSystem || "",
          catalogNumber: parsed.catalogNumber || "",
          nickname: parsed.nickname || "",
          formalName: parsed.formalName || "",
        }
      : dbWork
      ? {
          catalogSystem: dbWork.catalogSystem || "",
          catalogNumber: dbWork.catalogNumber || "",
          nickname: dbWork.nickname || "",
          formalName: dbWork.title || "",
        }
      : {
          catalogSystem: "",
          catalogNumber: "",
          nickname: "",
          formalName: "",
        };
    const movementInfo = parsed
      ? {
          movement: parsed.movement,
          movementName: parsed.movementName || "",
        }
      : dbMovement
      ? {
          movement: dbMovement.number,
          movementName: dbMovement.title || "",
        }
      : {
          movement: null,
          movementName: "",
        };

    return {
      composerName,
      ...workInfo,
      ...movementInfo,
    };
  };

  // Update edited metadata for a track
  const updateEditedMetadata = (trackId: string, field: keyof EditableMetadata, value: string | number | null) => {
    setEditedMetadata(prev => {
      const track = tracks.find(t => t.id === trackId);
      if (!track) return prev;

      const current = prev[trackId] || getEditableMetadata(track);
      return {
        ...prev,
        [trackId]: {
          ...current,
          [field]: value,
        },
      };
    });
  };

  const getWorkKey = (metadata: EditableMetadata) => {
    if (!metadata.catalogSystem || !metadata.catalogNumber) return null;
    return `${metadata.catalogSystem}:${metadata.catalogNumber}`;
  };

  // Helper to check if work exists in DB
  const workExistsInDb = (track: TrackData, metadata: EditableMetadata) => {
    const works = track.dbData?.works ?? [];

    // First check if track is already linked to a work
    const isLinked = works.some((w) => {
      if (metadata.catalogSystem && metadata.catalogNumber) {
        return w.catalogSystem === metadata.catalogSystem &&
               w.catalogNumber === metadata.catalogNumber;
      }
      return w.title === metadata.formalName;
    });

    if (isLinked) {
      return true;
    }

    // Then check the existingWorks record from batch lookup
    const workKey = getWorkKey(metadata);
    return workKey ? workKey in existingWorks : false;
  };

  // Helper to check if movement exists in DB
  const movementExistsInDb = (track: TrackData, metadata: EditableMetadata) => {
    if (metadata.movement == null) return false;

    // First check if track is already linked to this movement
    if (track.dbData?.movements?.some(m => m.number === metadata.movement)) {
      return true;
    }

    // Then check the existingWorks record for the movement
    const workKey = getWorkKey(metadata);
    const workData = workKey ? existingWorks[workKey] : undefined;
    return workData ? workData.movements.some(m => m.number === metadata.movement) : false;
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);

    try {
      // Filter unknown tracks and sort by album order for LLM context
      const unknownTracks = tracks
        .filter(t => !hasMetadata(t))
        .sort(compareTrackOrder);

      if (unknownTracks.length === 0) {
        onError?.("All tracks in this album are already in the database");
        return;
      }

      const parseInput = unknownTracks.map(t => ({
        trackName: t.name,
        artistNames: t.artists.map(a => a.name),
      }));

      // Send all album tracks to LLM together for better context
      const parsedResults = await parseAlbumTracks(album.name, parseInput);

      setTracks(prev => prev.map(track => {
        const unknownIndex = unknownTracks.findIndex(ut => ut.id === track.id);
        if (unknownIndex !== -1) {
          return { ...track, parsed: parsedResults[unknownIndex] };
        }
        return track;
      }));

      // Check which works already exist in the database
      const catalogQueries = parsedResults
        .filter(p => p.catalogSystem && p.catalogNumber)
        .map(p => ({ catalogSystem: p.catalogSystem!, catalogNumber: p.catalogNumber! }));

      if (catalogQueries.length > 0) {
        const existing = await checkWorksExist(catalogQueries);
        setExistingWorks(existing);
      }
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleLoadFullAlbum = async () => {
    setLoadingAlbum(true);
    try {
      const allTrackIds = await getAlbumTrackIds(album.id);
      const existingIds = new Set(tracks.map(t => t.id));
      const newTrackIds = allTrackIds.filter(id => !existingIds.has(id));

      if (newTrackIds.length === 0) {
        onSuccess?.("All album tracks are already loaded");
        return;
      }

      const newTrackUris = newTrackIds.map(id => `spotify:track:${id}`);
      const newTracks = await getBatchTrackMetadata(newTrackUris);
      setTracks(prev => [...prev, ...newTracks]);
      onSuccess?.(`Added ${newTracks.length} tracks from album`);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Failed to load album tracks");
    } finally {
      setLoadingAlbum(false);
    }
  };

  const handleSaveTrack = async (track: TrackData) => {
    const metadata = getEditableMetadata(track);

    if (!metadata.composerName || !metadata.formalName) {
      onError?.("Composer name and work title are required");
      return;
    }

    setSavingTracks(prev => new Set(prev).add(track.id));
    const startTime = performance.now();

    try {
      const composerArtist = track.artists.find(a => a.name === metadata.composerName);

      if (!composerArtist) {
        throw new Error(`Could not find composer artist: ${metadata.composerName}`);
      }

      let movementNumber = metadata.movement;

      if (!movementNumber) {
        const sameWorkTracks = tracks
          .filter(t => {
            if (t.album.id !== track.album.id) return false;

            const tMeta = getEditableMetadata(t);
            const metadataMatch = tMeta.catalogSystem === metadata.catalogSystem &&
                                  tMeta.catalogNumber === metadata.catalogNumber &&
                                  tMeta.composerName === metadata.composerName;

            return metadataMatch;
          })
          .sort((a, b) => a.track_number - b.track_number);

        if (sameWorkTracks.length > 1) {
          const position = sameWorkTracks.findIndex(t => t.id === track.id);
          movementNumber = position >= 0 ? position + 1 : -1;
        } else {
          movementNumber = 1;
        }
      }

      // Single consolidated server action
      await saveTrackWithMetadata({
        album: {
          id: track.album.id,
          name: track.album.name,
          release_date: track.album.release_date,
          popularity: track.album.popularity,
          images: track.album.images,
          inSpotifyAlbumsTable: track.album.inSpotifyAlbumsTable,
        },
        track: {
          id: track.id,
          name: track.name,
          uri: track.uri,
          duration_ms: track.duration_ms,
          track_number: track.track_number,
          popularity: track.popularity,
          inSpotifyTracksTable: track.inSpotifyTracksTable,
        },
        artists: track.artists.map(a => ({
          id: a.id,
          name: a.name,
          inSpotifyArtistsTable: a.inSpotifyArtistsTable,
          composerId: a.composerId,
        })),
        metadata: {
          composerArtistId: composerArtist.id,
          composerName: metadata.composerName,
          formalName: metadata.formalName,
          nickname: metadata.nickname || null,
          catalogSystem: metadata.catalogSystem || null,
          catalogNumber: metadata.catalogNumber || null,
          form: track.parsed?.form || null,
          movementNumber,
          movementName: metadata.movementName || null,
          yearComposed: track.parsed?.yearComposed || null,
        },
      });
      console.log(`[SaveTrack] completed in ${(performance.now() - startTime).toFixed(0)}ms`);

      // Update local state to mark as linked (skip refetch)
      setTracks(prev => prev.map(t =>
        t.id === track.id
          ? {
              ...t,
              inSpotifyTracksTable: true,
              album: { ...t.album, inSpotifyAlbumsTable: true },
              artists: t.artists.map(a => ({ ...a, inSpotifyArtistsTable: true })),
              dbData: {
                ...t.dbData,
                trackMovements: [{ spotifyTrackId: track.id, movementId: 0, startMs: null, endMs: null }],
              },
            }
          : t
      ));

      onSuccess?.(`Saved: ${track.name}`);
      onTrackSaved?.(track.id);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "An error occurred while saving");
    } finally {
      setSavingTracks(prev => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  };

  const handleUnlink = async (track: TrackData) => {
    if (!hasMetadata(track)) return;

    setSavingTracks(prev => new Set(prev).add(track.id));

    try {
      await deleteTrackMetadata(track.id);
      const updatedTrackData = await getBatchTrackMetadata([track.uri]);
      setTracks(prev => prev.map(t =>
        t.id === track.id ? { ...updatedTrackData[0], parsed: track.parsed } : t
      ));

      onSuccess?.(`Unlinked: ${track.name}`);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSavingTracks(prev => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  };

  const unknownCount = tracks.filter(t => !hasMetadata(t)).length;

  // Tracks that are ready to save (have parsed/edited metadata, not already linked)
  const readyTracks = tracks.filter(t => {
    if (hasMetadata(t)) return false;
    const metadata = getEditableMetadata(t);
    return metadata.composerName && metadata.formalName;
  });

  const handleSaveAll = async () => {
    if (readyTracks.length === 0) return;

    setSavingAll(true);
    let savedCount = 0;
    let errorCount = 0;

    for (const track of readyTracks) {
      try {
        await handleSaveTrack(track);
        savedCount++;
      } catch {
        errorCount++;
      }
    }

    setSavingAll(false);

    if (errorCount > 0) {
      onSuccess?.(`Saved ${savedCount} tracks, ${errorCount} failed`);
    } else {
      onSuccess?.(`Saved ${savedCount} tracks`);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
      {/* Album header */}
      <div className="flex items-center gap-4 p-4 bg-zinc-100 dark:bg-zinc-800">
        {album.images[0] && (
          <Image
            src={album.images[0].url}
            alt={album.name}
            width={64}
            height={64}
            className="rounded"
          />
        )}
        <div className="flex-1">
          <div className="font-semibold text-black dark:text-white">
            {album.name}
          </div>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            {album.release_date?.split('-')[0]} · {tracks.length} track{tracks.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleLoadFullAlbum}
            disabled={loadingAlbum}
            className="px-3 py-1.5 text-sm rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            {loadingAlbum && <Spinner />}
            {loadingAlbum ? "Loading..." : "Load Full Album"}
          </button>
          {unknownCount > 0 && (
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              {analyzing && <Spinner />}
              {analyzing ? "Analyzing..." : `Analyze ${unknownCount}`}
            </button>
          )}
          {readyTracks.length > 0 && (
            <button
              onClick={handleSaveAll}
              disabled={savingAll || savingTracks.size > 0}
              className="px-3 py-1.5 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              {savingAll && <Spinner />}
              {savingAll ? "Saving..." : `Save All (${readyTracks.length})`}
            </button>
          )}
        </div>
      </div>

      {/* Tracks table */}
      <table className="w-full">
        <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-xs text-zinc-600 dark:text-zinc-400">
          <tr>
            <th className="px-4 py-2 text-left">#</th>
            <th className="px-4 py-2 text-left">Track Name</th>
            <th className="px-4 py-2 text-left">Composer</th>
            <th className="px-4 py-2 text-left">Work</th>
            <th className="px-4 py-2 text-left">Movement</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="text-sm">
          {sortedTracks.map((track) => {
            const metadata = getEditableMetadata(track);
            const isLinked = hasMetadata(track);
            const canEdit = !isLinked && (track.parsed || editedMetadata[track.id]);
            const workInDb = workExistsInDb(track, metadata);
            const workKey = getWorkKey(metadata);
            const availableMovements = workKey ? existingWorks[workKey]?.movements ?? [] : [];
            const movementInDb = movementExistsInDb(track, metadata);
            const isSaving = savingTracks.has(track.id);

            const knownComposerArtist = track.artists.find((a) => a.inComposersTable);
            const effectiveComposer = metadata.composerName || knownComposerArtist?.name || "";
            const composerInDb = Boolean(
              effectiveComposer &&
              track.artists.find((a) => a.name === effectiveComposer)?.inComposersTable
            );

            let composerCell: ReactNode;
            if (!canEdit || composerInDb) {
              composerCell = (
                <div className="flex items-center gap-2">
                  <span>{effectiveComposer || "-"}</span>
                  {composerInDb && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                      ✓
                    </span>
                  )}
                </div>
              );
            } else {
              composerCell = (
                <div className="flex items-center gap-2">
                  <select
                    value={metadata.composerName}
                    onChange={(e) => updateEditedMetadata(track.id, "composerName", e.target.value)}
                    className="flex-1 px-2 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                  >
                    <option value="">Select composer...</option>
                    {track.artists.map((a) => (
                      <option key={a.id} value={a.name}>
                        {a.name}{a.inComposersTable ? " ✓" : ""}
                      </option>
                    ))}
                  </select>
                  {metadata.composerName && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 shrink-0">
                      new
                    </span>
                  )}
                </div>
              );
            }

            let workCell: ReactNode;
            if (!canEdit || workInDb) {
              workCell = (
                <div className="flex items-center gap-2">
                  {metadata.catalogSystem || metadata.catalogNumber || metadata.formalName ? (
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span>
                          {metadata.catalogSystem} {metadata.catalogNumber}
                          {metadata.nickname && ` "${metadata.nickname}"`}
                          {!metadata.catalogSystem && !metadata.catalogNumber && metadata.formalName}
                        </span>
                        {workInDb && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                            ✓
                          </span>
                        )}
                      </div>
                      {(metadata.catalogSystem || metadata.catalogNumber) && metadata.formalName && (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          {metadata.formalName}
                        </span>
                      )}
                    </div>
                  ) : (
                    "-"
                  )}
                </div>
              );
            } else {
              workCell = (
                <div className="flex items-start gap-2">
                  <div className="flex flex-col gap-1 flex-1">
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={metadata.catalogSystem}
                        onChange={(e) => updateEditedMetadata(track.id, "catalogSystem", e.target.value)}
                        placeholder="Cat."
                        className="w-12 px-1.5 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                      />
                      <input
                        type="text"
                        value={metadata.catalogNumber}
                        onChange={(e) => updateEditedMetadata(track.id, "catalogNumber", e.target.value)}
                        placeholder="No."
                        className="w-16 px-1.5 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                      />
                      <input
                        type="text"
                        value={metadata.nickname}
                        onChange={(e) => updateEditedMetadata(track.id, "nickname", e.target.value)}
                        placeholder="Nickname"
                        className="w-24 px-1.5 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                      />
                    </div>
                    <input
                      type="text"
                      value={metadata.formalName}
                      onChange={(e) => updateEditedMetadata(track.id, "formalName", e.target.value)}
                      placeholder="Work title (required)"
                      className="w-full px-1.5 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                    />
                  </div>
                  {metadata.formalName && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 shrink-0 mt-1">
                      new
                    </span>
                  )}
                </div>
              );
            }

            let movementCell: ReactNode;
            if (!canEdit) {
              movementCell = (
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span>{metadata.movement ?? "-"}</span>
                    {metadata.movement && movementInDb && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                        ✓
                      </span>
                    )}
                  </div>
                  {metadata.movementName && (
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                      {metadata.movementName}
                    </div>
                  )}
                </div>
              );
            } else if (workInDb && availableMovements.length > 0) {
              const existingNumbers = new Set(availableMovements.map((m) => m.number));
              const parsedMovement = track.parsed?.movement;
              const parsedMovementName = track.parsed?.movementName;
              const hasParsedNewMovement = parsedMovement != null && !existingNumbers.has(parsedMovement);
              const isCurrentMovementNew = metadata.movement != null && !existingNumbers.has(metadata.movement);

              movementCell = (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <select
                      value={metadata.movement ?? ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "__new__") {
                          updateEditedMetadata(track.id, "movement", null);
                        } else {
                          updateEditedMetadata(track.id, "movement", val ? parseInt(val) : null);
                        }
                      }}
                      className="flex-1 min-w-0 px-1.5 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                    >
                      <option value="">Select...</option>
                      {availableMovements
                        .sort((a, b) => a.number - b.number)
                        .map((mvt) => (
                          <option key={mvt.number} value={mvt.number}>
                            {toRoman(mvt.number)}.{mvt.title ? ` ${mvt.title}` : ""}
                          </option>
                        ))}
                      {hasParsedNewMovement && (
                        <option value={parsedMovement}>
                          {toRoman(parsedMovement)}.{parsedMovementName ? ` ${parsedMovementName}` : ""} (new)
                        </option>
                      )}
                      <option value="__new__">+ Add new...</option>
                    </select>
                    {metadata.movement != null && (
                      isCurrentMovementNew ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 shrink-0">
                          new
                        </span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 shrink-0">
                          ✓
                        </span>
                      )
                    )}
                  </div>
                  {isCurrentMovementNew && (
                    <div className="flex gap-1">
                      <input
                        type="number"
                        value={metadata.movement ?? ""}
                        onChange={(e) => updateEditedMetadata(track.id, "movement", e.target.value ? parseInt(e.target.value) : null)}
                        placeholder="#"
                        className="w-12 px-1.5 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                      />
                      <input
                        type="text"
                        value={metadata.movementName}
                        onChange={(e) => updateEditedMetadata(track.id, "movementName", e.target.value)}
                        placeholder="Movement name"
                        className="flex-1 px-1.5 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                      />
                    </div>
                  )}
                </div>
              );
            } else {
              movementCell = (
                <div className="flex items-start gap-2">
                  <div className="flex flex-col gap-1 flex-1">
                    <input
                      type="number"
                      value={metadata.movement ?? ""}
                      onChange={(e) => updateEditedMetadata(track.id, "movement", e.target.value ? parseInt(e.target.value) : null)}
                      placeholder="#"
                      className="w-12 px-1.5 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                    />
                    <input
                      type="text"
                      value={metadata.movementName}
                      onChange={(e) => updateEditedMetadata(track.id, "movementName", e.target.value)}
                      placeholder="Movement name"
                      className="w-full px-1.5 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
                    />
                  </div>
                  {metadata.movement != null && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 shrink-0 mt-1">
                      new
                    </span>
                  )}
                </div>
              );
            }

            return (
              <tr key={track.id} className="border-t border-zinc-200 dark:border-zinc-700">
                <td className="px-4 py-3 text-zinc-500">{track.track_number}</td>
                <td className="px-4 py-3">
                  <div>
                    <div className="text-black dark:text-white">{track.name}</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                      {track.artists.map((a, idx) => (
                        <span key={a.id}>
                          {idx > 0 && ", "}
                          <span
                            className={
                              metadata.composerName === a.name
                                ? "font-semibold text-zinc-700 dark:text-zinc-300"
                                : ""
                            }
                          >
                            {a.name}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{composerCell}</td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{workCell}</td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{movementCell}</td>
                <td className="px-4 py-3">
                  {isLinked ? (
                    <span className="text-xs px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                      Linked
                    </span>
                  ) : track.parsed || editedMetadata[track.id] ? (
                    <span className="text-xs px-2 py-1 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                      Ready
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-900/30 text-gray-700 dark:text-gray-400">
                      Unknown
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {canEdit ? (
                    <button
                      onClick={() => handleSaveTrack(track)}
                      disabled={isSaving}
                      className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                    >
                      {isSaving && <Spinner className="w-3 h-3" />}
                      {isSaving ? "Saving..." : "Save"}
                    </button>
                  ) : isLinked ? (
                    <button
                      onClick={() => handleUnlink(track)}
                      disabled={isSaving}
                      className="text-xs px-3 py-1 rounded bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                    >
                      {isSaving && <Spinner className="w-3 h-3" />}
                      {isSaving ? "Unlinking..." : "Unlink"}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
