"use client";

import { authClient } from "@/lib/auth-client";
import { useState } from "react";
import {
  addTrackToDatabase,
  addAlbumToDatabase,
  addArtistsToDatabase,
  addComposer,
  checkWorkAndMovement,
  addWorkMovementAndTrack,
  getTrackMetadata,
} from "./actions";
import { parseTrackMetadata, type ClassicalMetadata } from "./parse-track";

interface SpotifyArtist {
  id: string;
  name: string;
  uri: string;
  inSpotifyArtistsTable: boolean;
  inComposersTable: boolean;
  composerId?: string;
}

interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  track_number: number;
  popularity: number;
  inSpotifyTracksTable: boolean;
  artists: SpotifyArtist[];
  album: {
    id: string;
    name: string;
    uri: string;
    release_date: string;
    popularity: number;
    inSpotifyAlbumsTable: boolean;
    images: {
      url: string;
      height: number;
      width: number;
    }[];
  };
  dbData?: {
    track: any;
    album: any;
    artists: any[];
    composers: any[];
    trackMovements: any[];
    movements: any[];
    works: any[];
    recordings: any[];
  };
}

export default function AdminPage() {
  const { data: session } = authClient.useSession();
  const [trackUrisInput, setTrackUrisInput] = useState("");
  const [trackUris, setTrackUris] = useState<string[]>([]);
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [metadata, setMetadata] = useState<SpotifyTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingComposer, setAddingComposer] = useState<string | null>(null);
  const [addingTrack, setAddingTrack] = useState(false);
  const [addingAlbum, setAddingAlbum] = useState(false);
  const [addingArtists, setAddingArtists] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [parsedMetadata, setParsedMetadata] = useState<ClassicalMetadata | null>(null);
  const [parsing, setParsing] = useState(false);
  const [workMovementStatus, setWorkMovementStatus] = useState<{
    workExists: boolean;
    movementExists: boolean;
    work: any;
    movement: any;
  } | null>(null);
  const [checkingWorkMovement, setCheckingWorkMovement] = useState(false);
  const [addingWorkMovement, setAddingWorkMovement] = useState(false);

  // Check if user is benwaffle
  const isAdmin = session?.user?.name === "benwaffle";

  const parseTrackUris = (input: string): string[] => {
    const lines = input.trim().split('\n').filter(line => line.trim());
    return lines;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMetadata(null);
    setParsedMetadata(null);
    setWorkMovementStatus(null);

    // Parse input into array of track URIs
    const uris = parseTrackUris(trackUrisInput);

    if (uris.length === 0) {
      setError("Please enter at least one Spotify track URI or URL");
      setLoading(false);
      return;
    }

    setTrackUris(uris);
    setCurrentTrackIndex(0);

    // Load first track
    const trackUri = uris[0];

    try {
      const data = await getTrackMetadata(trackUri);
      setMetadata(data);

      // Parse track metadata with AI
      setParsing(true);
      try {
        const artistNames = data.artists.map((a: any) => a.name);
        const parsed = await parseTrackMetadata(data.name, artistNames);
        setParsedMetadata(parsed);

        // Check if work and movement exist in DB
        if (
          parsed.isClassical &&
          parsed.catalogSystem &&
          parsed.catalogNumber &&
          parsed.movement !== null
        ) {
          // Find composer from artists
          const composerArtist = data.artists.find((a: any) => a.inComposersTable);
          if (composerArtist?.composerId) {
            setCheckingWorkMovement(true);
            try {
              const status = await checkWorkAndMovement(
                composerArtist.composerId,
                parsed.catalogSystem,
                parsed.catalogNumber,
                parsed.movement
              );
              setWorkMovementStatus(status);
            } catch (err) {
              console.error("Failed to check work/movement:", err);
            } finally {
              setCheckingWorkMovement(false);
            }
          }
        }
      } catch (parseErr) {
        console.error("Failed to parse track metadata:", parseErr);
        // Don't throw - parsing is optional
      } finally {
        setParsing(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleAddComposer = async (artistId: string, artistName: string) => {
    setAddingComposer(artistId);
    setError(null);
    setSuccessMessage(null);

    try {
      await addComposer(artistId, artistName);

      // Refresh metadata to update status
      await refreshMetadata();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setAddingComposer(null);
    }
  };

  const loadTrack = async (index: number) => {
    if (trackUris.length === 0 || index < 0 || index >= trackUris.length) return;

    setLoading(true);
    setError(null);
    setMetadata(null);
    setParsedMetadata(null);
    setWorkMovementStatus(null);
    setCurrentTrackIndex(index);

    const trackUri = trackUris[index];

    try {
      const data = await getTrackMetadata(trackUri);
      setMetadata(data);

      // Parse track metadata with AI
      setParsing(true);
      try {
        const artistNames = data.artists.map((a: any) => a.name);
        const parsed = await parseTrackMetadata(data.name, artistNames);
        setParsedMetadata(parsed);

        // Check if work and movement exist in DB
        if (
          parsed.isClassical &&
          parsed.catalogSystem &&
          parsed.catalogNumber &&
          parsed.movement !== null
        ) {
          // Find composer from artists
          const composerArtist = data.artists.find((a: any) => a.inComposersTable);
          if (composerArtist?.composerId) {
            setCheckingWorkMovement(true);
            try {
              const status = await checkWorkAndMovement(
                composerArtist.composerId,
                parsed.catalogSystem,
                parsed.catalogNumber,
                parsed.movement
              );
              setWorkMovementStatus(status);
            } catch (err) {
              console.error("Failed to check work/movement:", err);
            } finally {
              setCheckingWorkMovement(false);
            }
          }
        }
      } catch (parseErr) {
        console.error("Failed to parse track metadata:", parseErr);
        // Don't throw - parsing is optional
      } finally {
        setParsing(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const refreshMetadata = async () => {
    if (trackUris.length === 0) return;
    await loadTrack(currentTrackIndex);
  };

  const handlePrevious = () => {
    if (currentTrackIndex > 0) {
      loadTrack(currentTrackIndex - 1);
    }
  };

  const handleNext = () => {
    if (currentTrackIndex < trackUris.length - 1) {
      loadTrack(currentTrackIndex + 1);
    }
  };

  const handleAddTrack = async () => {
    if (!metadata) return;

    setAddingTrack(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const result = await addTrackToDatabase({
        id: metadata.id,
        name: metadata.name,
        uri: metadata.uri,
        duration_ms: metadata.duration_ms,
        track_number: metadata.track_number,
        popularity: metadata.popularity,
        albumId: metadata.album.id,
        artists: metadata.artists.map((a) => ({ id: a.id, name: a.name })),
      });

      setSuccessMessage(result.message);
      await refreshMetadata();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setAddingTrack(false);
    }
  };

  const handleAddAlbum = async () => {
    if (!metadata) return;

    setAddingAlbum(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const result = await addAlbumToDatabase({
        id: metadata.album.id,
        name: metadata.album.name,
        release_date: metadata.album.release_date,
        popularity: metadata.album.popularity,
        images: metadata.album.images,
      });

      setSuccessMessage(result.message);
      await refreshMetadata();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setAddingAlbum(false);
    }
  };

  const handleAddArtists = async () => {
    if (!metadata) return;

    setAddingArtists(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const result = await addArtistsToDatabase(
        metadata.artists.map((a) => ({ id: a.id, name: a.name }))
      );

      setSuccessMessage(result.message);
      await refreshMetadata();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setAddingArtists(false);
    }
  };

  const handleAddWorkMovement = async () => {
    if (!metadata || !parsedMetadata) return;

    const composerArtist = metadata.artists.find((a) => a.inComposersTable);
    if (!composerArtist?.composerId) {
      setError("No composer found. Please add an artist as a composer first.");
      return;
    }

    if (
      !parsedMetadata.catalogSystem ||
      !parsedMetadata.catalogNumber ||
      parsedMetadata.movement === null
    ) {
      setError("Missing required metadata: catalog system, catalog number, or movement");
      return;
    }

    setAddingWorkMovement(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const result = await addWorkMovementAndTrack({
        composerId: composerArtist.composerId,
        formalName: parsedMetadata.formalName,
        nickname: parsedMetadata.nickname,
        catalogSystem: parsedMetadata.catalogSystem,
        catalogNumber: parsedMetadata.catalogNumber,
        key: parsedMetadata.key,
        form: parsedMetadata.form,
        movementNumber: parsedMetadata.movement,
        movementName: parsedMetadata.movementName,
        yearComposed: parsedMetadata.yearComposed,
        spotifyTrackId: metadata.id,
        spotifyAlbumId: metadata.album.id,
      });

      setSuccessMessage(result.message);

      // Refresh work/movement status
      setCheckingWorkMovement(true);
      try {
        const status = await checkWorkAndMovement(
          composerArtist.composerId,
          parsedMetadata.catalogSystem,
          parsedMetadata.catalogNumber,
          parsedMetadata.movement
        );
        setWorkMovementStatus(status);
      } catch (err) {
        console.error("Failed to check work/movement:", err);
      } finally {
        setCheckingWorkMovement(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setAddingWorkMovement(false);
    }
  };

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Please sign in to access this page
        </p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Access denied
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
      <main className="flex w-full max-w-4xl flex-col gap-8 py-16 px-8 bg-white dark:bg-black">
        <h1 className="text-4xl font-bold text-black dark:text-zinc-50">
          Admin - Spotify Track Metadata
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label
              htmlFor="trackUris"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Spotify Track URI(s) or URL(s) (one per line)
            </label>
            <textarea
              id="trackUris"
              value={trackUrisInput}
              onChange={(e) => setTrackUrisInput(e.target.value)}
              placeholder="spotify:track:... or https://open.spotify.com/track/...&#10;One URI/URL per line"
              className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-2 text-black dark:text-white min-h-[100px]"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="flex h-12 items-center justify-center rounded-full bg-black px-8 text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 disabled:opacity-50 cursor-pointer"
          >
            {loading ? "Loading..." : "Load Tracks"}
          </button>
        </form>

        {trackUris.length > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-4 py-3">
            <button
              onClick={handlePrevious}
              disabled={currentTrackIndex === 0 || loading}
              className="px-4 py-2 rounded-lg bg-zinc-200 dark:bg-zinc-800 text-black dark:text-white hover:bg-zinc-300 dark:hover:bg-zinc-700 disabled:opacity-50 cursor-pointer"
            >
              ← Previous
            </button>
            <span className="text-sm font-medium text-black dark:text-white">
              Track {currentTrackIndex + 1} of {trackUris.length}
            </span>
            <button
              onClick={handleNext}
              disabled={currentTrackIndex === trackUris.length - 1 || loading}
              className="px-4 py-2 rounded-lg bg-zinc-200 dark:bg-zinc-800 text-black dark:text-white hover:bg-zinc-300 dark:hover:bg-zinc-700 disabled:opacity-50 cursor-pointer"
            >
              Next →
            </button>
          </div>
        )}

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

        {metadata && (
          <>
            {/* Database Info Section */}
            {metadata.dbData && (metadata.dbData.works.length > 0 || metadata.dbData.composers.length > 0) && (
              <div className="rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20 p-6">
                <h2 className="text-xl font-bold text-black dark:text-zinc-50 mb-4">
                  Database Information
                </h2>

                {/* Composers */}
                {metadata.dbData.composers.length > 0 && (
                  <div className="mb-4">
                    <h3 className="text-md font-semibold text-black dark:text-zinc-50 mb-2">Composers</h3>
                    {metadata.dbData.composers.map((comp: any) => (
                      <div key={comp.id} className="text-sm text-black dark:text-white mb-1">
                        {comp.name} (ID: {comp.id})
                      </div>
                    ))}
                  </div>
                )}

                {/* Works and Movements */}
                {metadata.dbData.works.length > 0 && (
                  <div className="mb-4">
                    <h3 className="text-md font-semibold text-black dark:text-zinc-50 mb-2">Works & Movements</h3>
                    {metadata.dbData.works.map((w: any) => {
                      const workMovements = metadata.dbData!.movements.filter((m: any) => m.workId === w.id);
                      const workRecordings = metadata.dbData!.recordings.filter((r: any) => r.workId === w.id);
                      return (
                        <div key={w.id} className="mb-3 pl-3 border-l-2 border-green-400 dark:border-green-600">
                          <div className="text-sm font-medium text-black dark:text-white">
                            {w.title} {w.nickname && `"${w.nickname}"`}
                          </div>
                          <div className="text-xs text-zinc-600 dark:text-zinc-400">
                            {w.catalogSystem} {w.catalogNumber}
                            {w.yearComposed && ` (${w.yearComposed})`}
                            {w.form && ` - ${w.form}`}
                          </div>
                          {workRecordings.length > 0 && (
                            <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                              {workRecordings.length} recording{workRecordings.length !== 1 ? 's' : ''} in database
                            </div>
                          )}
                          {workMovements.length > 0 && (
                            <div className="mt-2">
                              {workMovements.map((m: any) => {
                                const tm = metadata.dbData!.trackMovements.find((t: any) => t.movementId === m.id);
                                return (
                                  <div key={m.id} className="text-xs text-zinc-700 dark:text-zinc-300 ml-3">
                                    Movement {m.number}{m.title && `: ${m.title}`}
                                    {tm && tm.startMs !== null && ` (${tm.startMs}ms - ${tm.endMs}ms)`}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Album */}
                {metadata.dbData.album && (
                  <div className="mb-4">
                    <h3 className="text-md font-semibold text-black dark:text-zinc-50 mb-2">Spotify - Album</h3>
                    <div className="text-sm text-black dark:text-white">
                      {metadata.dbData.album.title} {metadata.dbData.album.year && `(${metadata.dbData.album.year})`}
                    </div>
                    {metadata.dbData.album.popularity && (
                      <div className="text-xs text-zinc-600 dark:text-zinc-400">
                        Popularity: {metadata.dbData.album.popularity}
                      </div>
                    )}
                  </div>
                )}

                {/* Artists */}
                {metadata.dbData.artists.length > 0 && (
                  <div>
                    <h3 className="text-md font-semibold text-black dark:text-zinc-50 mb-2">Spotify - Artists</h3>
                    {metadata.dbData.artists.map((artist: any) => (
                      <div key={artist.spotifyId} className="text-sm text-black dark:text-white">
                        {artist.name}
                        {artist.popularity && ` (Popularity: ${artist.popularity})`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-4 rounded-lg border border-zinc-300 dark:border-zinc-700 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold text-black dark:text-zinc-50">
                Track Metadata
              </h2>
              <div className="flex gap-2">
                <button
                  onClick={handleAddAlbum}
                  disabled={addingAlbum || metadata.album.inSpotifyAlbumsTable}
                  className="px-3 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
                >
                  {addingAlbum ? "Adding..." : metadata.album.inSpotifyAlbumsTable ? "Album Added" : "Add Album"}
                </button>
                <button
                  onClick={handleAddArtists}
                  disabled={addingArtists}
                  className="px-3 py-2 text-sm rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 cursor-pointer"
                >
                  {addingArtists ? "Adding..." : "Add Artists"}
                </button>
                <button
                  onClick={handleAddTrack}
                  disabled={addingTrack || metadata.inSpotifyTracksTable}
                  className="px-3 py-2 text-sm rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 cursor-pointer"
                >
                  {addingTrack ? "Adding..." : metadata.inSpotifyTracksTable ? "Track Added" : "Add Track"}
                </button>
              </div>
            </div>

            {metadata.album.images[0] && (
              <img
                src={metadata.album.images[0].url}
                alt={metadata.album.name}
                className="w-48 h-48 rounded-lg"
              />
            )}

            <div className="grid grid-cols-[120px_1fr] gap-2 text-sm">
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Track Name:
              </span>
              <span className="text-black dark:text-white">
                {metadata.name}
              </span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Track ID:
              </span>
              <span className="text-black dark:text-white">{metadata.id}</span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Track URI:
              </span>
              <span className="text-black dark:text-white">{metadata.uri}</span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Track Status:
              </span>
              <span className="text-xs">
                {metadata.inSpotifyTracksTable ? (
                  <span className="text-green-600 dark:text-green-400">
                    ✓ In spotify_tracks
                  </span>
                ) : (
                  <span className="text-zinc-500 dark:text-zinc-400">
                    ✗ Not in spotify_tracks
                  </span>
                )}
              </span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Duration:
              </span>
              <span className="text-black dark:text-white">
                {Math.floor(metadata.duration_ms / 60000)}:
                {String(Math.floor((metadata.duration_ms % 60000) / 1000)).padStart(2, "0")}
              </span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Track Number:
              </span>
              <span className="text-black dark:text-white">
                {metadata.track_number}
              </span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Track Popularity:
              </span>
              <span className="text-black dark:text-white">
                {metadata.popularity}
              </span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Artists:
              </span>
              <div className="flex flex-col gap-2">
                {metadata.artists.map((artist) => (
                  <div
                    key={artist.id}
                    className="flex items-center gap-2 text-black dark:text-white"
                  >
                    <div className="flex-1">
                      <div>{artist.name}</div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        {artist.uri}
                      </div>
                      <div className="text-xs mt-1">
                        {artist.inSpotifyArtistsTable && (
                          <span className="text-green-600 dark:text-green-400">
                            ✓ In spotify_artists
                          </span>
                        )}
                        {!artist.inSpotifyArtistsTable && (
                          <span className="text-zinc-500 dark:text-zinc-400">
                            ✗ Not in spotify_artists
                          </span>
                        )}
                        {" | "}
                        {artist.inComposersTable && (
                          <span className="text-green-600 dark:text-green-400">
                            ✓ In composers (ID: {artist.composerId})
                          </span>
                        )}
                        {!artist.inComposersTable && (
                          <span className="text-zinc-500 dark:text-zinc-400">
                            ✗ Not in composers
                          </span>
                        )}
                      </div>
                    </div>
                    {!artist.inComposersTable && (
                      <button
                        onClick={() => handleAddComposer(artist.id, artist.name)}
                        disabled={addingComposer === artist.id}
                        className="px-3 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
                      >
                        {addingComposer === artist.id
                          ? "Adding..."
                          : "Add as Composer"}
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Album Name:
              </span>
              <span className="text-black dark:text-white">
                {metadata.album.name}
              </span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Album ID:
              </span>
              <span className="text-black dark:text-white">
                {metadata.album.id}
              </span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Album URI:
              </span>
              <span className="text-black dark:text-white">
                {metadata.album.uri}
              </span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Album Status:
              </span>
              <span className="text-xs">
                {metadata.album.inSpotifyAlbumsTable ? (
                  <span className="text-green-600 dark:text-green-400">
                    ✓ In spotify_albums
                  </span>
                ) : (
                  <span className="text-zinc-500 dark:text-zinc-400">
                    ✗ Not in spotify_albums
                  </span>
                )}
              </span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Album Popularity:
              </span>
              <span className="text-black dark:text-white">
                {metadata.album.popularity}
              </span>

              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Release Date:
              </span>
              <span className="text-black dark:text-white">
                {metadata.album.release_date}
              </span>
            </div>

            {/* AI Parsed Metadata */}
            {parsing && (
              <div className="mt-4 rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 px-4 py-3">
                <p className="text-blue-700 dark:text-blue-300">
                  Parsing track metadata with AI...
                </p>
              </div>
            )}

            {parsedMetadata && (
              <div className="mt-4 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 p-4">
                <h3 className="text-lg font-semibold text-black dark:text-zinc-50 mb-3">
                  AI Parsed Classical Metadata
                </h3>
                <div className="grid grid-cols-[140px_1fr] gap-2 text-sm">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    Is Classical:
                  </span>
                  <span className="text-black dark:text-white">
                    {parsedMetadata.isClassical ? "✓ Yes" : "✗ No"}
                  </span>

                  {parsedMetadata.isClassical && (
                    <>
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        Formal Name:
                      </span>
                      <span className="text-black dark:text-white">
                        {parsedMetadata.formalName}
                      </span>

                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        Nickname:
                      </span>
                      <span className="text-black dark:text-white">
                        {parsedMetadata.nickname ?? "None"}
                      </span>

                      {parsedMetadata.catalogSystem && (
                        <>
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            Catalog System:
                          </span>
                          <span className="text-black dark:text-white">
                            {parsedMetadata.catalogSystem}
                          </span>
                        </>
                      )}

                      {parsedMetadata.catalogNumber && (
                        <>
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            Catalog Number:
                          </span>
                          <span className="text-black dark:text-white">
                            {parsedMetadata.catalogNumber}
                          </span>
                        </>
                      )}

                      {parsedMetadata.key && (
                        <>
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            Key:
                          </span>
                          <span className="text-black dark:text-white">
                            {parsedMetadata.key}
                          </span>
                        </>
                      )}

                      {parsedMetadata.form && (
                        <>
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            Form:
                          </span>
                          <span className="text-black dark:text-white">
                            {parsedMetadata.form}
                          </span>
                        </>
                      )}

                      {parsedMetadata.movement !== null && (
                        <>
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            Movement:
                          </span>
                          <span className="text-black dark:text-white">
                            {parsedMetadata.movement}
                          </span>
                        </>
                      )}

                      {parsedMetadata.movementName && (
                        <>
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            Movement Name:
                          </span>
                          <span className="text-black dark:text-white">
                            {parsedMetadata.movementName}
                          </span>
                        </>
                      )}

                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        Year Composed:
                      </span>
                      <span className="text-black dark:text-white">
                        {parsedMetadata.yearComposed ?? "Unknown"}
                      </span>
                    </>
                  )}
                </div>

                {/* Work and Movement Status */}
                {parsedMetadata.isClassical && (
                  <div className="mt-4 pt-4 border-t border-zinc-300 dark:border-zinc-700">
                    {checkingWorkMovement && (
                      <p className="text-sm text-blue-600 dark:text-blue-400">
                        Checking database for work and movement...
                      </p>
                    )}

                    {workMovementStatus && (
                      <>
                        <h4 className="text-md font-semibold text-black dark:text-zinc-50 mb-2">
                          Database Status
                        </h4>
                        <div className="grid grid-cols-[140px_1fr] gap-2 text-sm mb-3">
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            Work:
                          </span>
                          <span className="text-xs">
                            {workMovementStatus.workExists ? (
                              <span className="text-green-600 dark:text-green-400">
                                ✓ Exists (ID: {workMovementStatus.work.id})
                              </span>
                            ) : (
                              <span className="text-zinc-500 dark:text-zinc-400">
                                ✗ Not found
                              </span>
                            )}
                          </span>

                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            Movement:
                          </span>
                          <span className="text-xs">
                            {workMovementStatus.movementExists ? (
                              <span className="text-green-600 dark:text-green-400">
                                ✓ Exists (ID: {workMovementStatus.movement.id})
                              </span>
                            ) : (
                              <span className="text-zinc-500 dark:text-zinc-400">
                                ✗ Not found
                              </span>
                            )}
                          </span>
                        </div>

                        <button
                          onClick={handleAddWorkMovement}
                          disabled={addingWorkMovement}
                          className="px-4 py-2 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 cursor-pointer"
                        >
                          {addingWorkMovement
                            ? "Adding..."
                            : workMovementStatus.workExists && workMovementStatus.movementExists
                            ? "Update Work & Movement"
                            : "Add Work & Movement"}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          </>
        )}
      </main>
    </div>
  );
}
