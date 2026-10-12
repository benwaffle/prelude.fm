import { db } from '@/lib/db';
import { matchQueue, trackRecording } from '@/lib/db/schema';
import {
  getSpotifyAlbumMetadata,
  getSpotifyAlbumTrackIds,
  getSpotifyAlbumTracks,
  getSpotifyTracksByIds,
} from '@/lib/spotify-app-client';
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Track } from '@spotify/web-api-ts-sdk';
import { runMusicBrainzAlbumPass } from '@/lib/musicbrainz-worker';
import type { MusicBrainzSource } from '@/lib/musicbrainz-source';
import { forChunks } from '@/lib/db/chunked';
import { recordAlbumPassOutcomes } from '@/lib/musicbrainz-pipeline-state';

// Lease state, not the verdict. `unresolved`: the pass found nothing to hand the reader; not
// `failed` (retrying asks the same question) and not `matched`. The why lives in `pipeline_outcome`
// / `pipeline_reason`.
export type MatchQueueStatus = (typeof matchQueue.$inferSelect)['status'];

export interface EnqueueResult {
  submitted: number;
  expanded: number;
  alreadyQueued: number;
  albumIds: string[];
  queuedTrackIds: string[];
}

export interface AlbumProcessResult {
  albumId: string;
  claimed: number;
  matched: number;
  failed: number;
  notClassical: number;
  /** Tracks the pass finished with but could not place. Not errors. */
  unresolved: number;
  errors: Array<{ trackId?: string; message: string; retryable?: boolean }>;
  musicbrainz?: {
    releaseCached: boolean;
    anchored: number;
    requests: number;
  };
}

export interface ClaimedAlbum {
  albumId: string;
  trackIds: string[];
}

export interface QueueWorkerResult {
  albums: AlbumProcessResult[];
  recovered: number;
  retried: number;
  exhausted: number;
  musicbrainz: {
    albumsCached: number;
    tracksAnchored: number;
    worksRead: number;
    /** Work stubs asked for that MusicBrainz did not return as themselves. */
    worksUnavailable: number;
    recordingsRead: number;
    artistsRead: number;
    requests: number;
    /** Set when the budget refused the pass, so a caller can stop chaining. */
    stopped: string | null;
  };
  /** Non-empty means stop. */
  brokenInvariants: { name: string; violations: number }[];
}

function now() {
  return new Date();
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isRetryableProcessingError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('429') ||
    normalized.includes('408') ||
    normalized.includes('409') ||
    normalized.includes('500') ||
    normalized.includes('502') ||
    normalized.includes('503') ||
    normalized.includes('504') ||
    normalized.includes('rate limit') ||
    normalized.includes('rate-limit') ||
    normalized.includes('rate limits') ||
    normalized.includes('too many requests') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnreset') ||
    normalized.includes('socket hang up') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('overloaded')
  );
}

function compareTrackOrder(a: Track, b: Track) {
  return a.disc_number - b.disc_number || a.track_number - b.track_number;
}

// With `heldBy`, only rows that worker still holds are touched; the claim itself is left as it is.
async function setQueueStatus(
  trackIds: string[],
  status: MatchQueueStatus,
  options: { heldBy?: string; errorMessage?: string } = {},
) {
  if (trackIds.length === 0) return;

  await db
    .update(matchQueue)
    .set({
      status,
      processedAt: status === 'processing' || status === 'pending' ? null : now(),
      errorMessage: options.errorMessage ?? null,
    })
    .where(
      and(
        inArray(matchQueue.spotifyId, trackIds),
        options.heldBy ? eq(matchQueue.claimOwnerId, options.heldBy) : undefined,
      ),
    );
}

async function enqueueAlbumTracks(albumId: string, submittedBy: string) {
  const [album, albumTrackIds] = await Promise.all([
    getSpotifyAlbumMetadata(albumId),
    getSpotifyAlbumTrackIds(albumId),
  ]);

  if (albumTrackIds.length === 0) {
    return { albumId, trackIds: [] as string[], submitted: 0, alreadyQueued: 0 };
  }

  const existingRows = await db
    .select({
      spotifyId: matchQueue.spotifyId,
      status: matchQueue.status,
      spotifyAlbumId: matchQueue.spotifyAlbumId,
    })
    .from(matchQueue)
    .where(inArray(matchQueue.spotifyId, albumTrackIds));

  const existingById = new Map(existingRows.map((row) => [row.spotifyId, row]));
  const newTrackIds = albumTrackIds.filter((trackId) => !existingById.has(trackId));
  const missingAlbumIds = existingRows
    .filter((row) => row.spotifyAlbumId !== album.id)
    .map((row) => row.spotifyId);

  if (newTrackIds.length > 0) {
    await db.insert(matchQueue).values(
      newTrackIds.map((trackId) => ({
        spotifyId: trackId,
        spotifyAlbumId: album.id,
        submittedBy,
        status: 'pending' as const,
      })),
    );
  }

  if (missingAlbumIds.length > 0) {
    await db
      .update(matchQueue)
      .set({ spotifyAlbumId: album.id })
      .where(inArray(matchQueue.spotifyId, missingAlbumIds));
  }

  return {
    albumId,
    trackIds: albumTrackIds,
    submitted: newTrackIds.length,
    alreadyQueued: albumTrackIds.length - newTrackIds.length,
  };
}

export async function enqueueAlbumsForTracks(
  trackIds: string[],
  submittedBy: string,
): Promise<EnqueueResult> {
  if (trackIds.length === 0) {
    return { submitted: 0, expanded: 0, alreadyQueued: 0, albumIds: [], queuedTrackIds: [] };
  }

  const tracks = await getSpotifyTracksByIds([...new Set(trackIds)]);
  const albumIds = [...new Set(tracks.map((track) => track.album.id))];

  let submitted = 0;
  let alreadyQueued = 0;
  const queuedTrackIds = new Set<string>();

  for (const albumId of albumIds) {
    const result = await enqueueAlbumTracks(albumId, submittedBy);
    submitted += result.submitted;
    alreadyQueued += result.alreadyQueued;
    result.trackIds.forEach((trackId) => queuedTrackIds.add(trackId));
  }

  return {
    submitted,
    expanded: queuedTrackIds.size,
    alreadyQueued,
    albumIds,
    queuedTrackIds: [...queuedTrackIds],
  };
}

async function hydratePendingRowsWithoutAlbumIds(limit = 50) {
  const rows = await db
    .select({ spotifyId: matchQueue.spotifyId, submittedBy: matchQueue.submittedBy })
    .from(matchQueue)
    .where(and(eq(matchQueue.status, 'pending'), isNull(matchQueue.spotifyAlbumId)))
    .limit(limit);

  if (rows.length === 0) return 0;

  const tracks = await getSpotifyTracksByIds(rows.map((row) => row.spotifyId));
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const submitterByAlbumId = new Map<string, string>();

  for (const row of rows) {
    const track = trackById.get(row.spotifyId);
    if (!track) {
      await setQueueStatus([row.spotifyId], 'failed', {
        errorMessage: 'Spotify track was not found',
      });
      continue;
    }

    submitterByAlbumId.set(
      track.album.id,
      submitterByAlbumId.get(track.album.id) ?? row.submittedBy,
    );
    await db
      .update(matchQueue)
      .set({ spotifyAlbumId: track.album.id })
      .where(eq(matchQueue.spotifyId, row.spotifyId));
  }

  for (const [albumId, submittedBy] of submitterByAlbumId) {
    await enqueueAlbumTracks(albumId, submittedBy);
  }

  return submitterByAlbumId.size;
}

async function getNextPendingAlbumId(maxAttempts?: number) {
  const next = async () => {
    const [row] = await db
      .select({ spotifyAlbumId: matchQueue.spotifyAlbumId })
      .from(matchQueue)
      .where(
        and(
          eq(matchQueue.status, 'pending'),
          isNotNull(matchQueue.spotifyAlbumId),
          maxAttempts === undefined ? undefined : lt(matchQueue.attempts, maxAttempts),
        ),
      )
      .groupBy(matchQueue.spotifyAlbumId)
      .limit(1);
    return row?.spotifyAlbumId ?? null;
  };

  const found = await next();
  if (found) return found;
  if ((await hydratePendingRowsWithoutAlbumIds()) === 0) return null;
  return next();
}

export async function claimNextPendingAlbum(
  claimOwnerId: string,
  maxAttempts?: number,
): Promise<ClaimedAlbum | null> {
  for (let collisionRetry = 0; collisionRetry < 10; collisionRetry++) {
    const albumId = await getNextPendingAlbumId(maxAttempts);
    if (!albumId) return null;

    const claim = await claimPendingAlbum(albumId, claimOwnerId, maxAttempts);
    if (claim) return claim;
  }

  return null;
}

export async function prepareMatchQueue(
  options: {
    maxAttempts?: number;
    staleMinutes?: number;
    retryFailed?: boolean;
  } = {},
) {
  const maxAttempts = options.maxAttempts ?? 5;
  const staleMinutes = options.staleMinutes ?? 30;
  const staleBefore = new Date(Date.now() - staleMinutes * 60_000);

  const recovered = await db
    .update(matchQueue)
    .set({ status: 'pending', claimOwnerId: null })
    .where(
      and(
        eq(matchQueue.status, 'processing'),
        or(isNull(matchQueue.lastAttemptAt), lt(matchQueue.lastAttemptAt, staleBefore)),
      ),
    )
    .returning({ spotifyId: matchQueue.spotifyId });

  const retried = options.retryFailed
    ? await db
        .update(matchQueue)
        .set({ status: 'pending', processedAt: null, claimOwnerId: null })
        .where(and(eq(matchQueue.status, 'failed'), lt(matchQueue.attempts, maxAttempts)))
        .returning({ spotifyId: matchQueue.spotifyId })
    : [];

  const exhausted = await db
    .update(matchQueue)
    .set({
      status: 'failed',
      processedAt: now(),
      errorMessage: sql`coalesce(${matchQueue.errorMessage}, 'Maximum processing attempts reached')`,
    })
    .where(and(eq(matchQueue.status, 'pending'), gte(matchQueue.attempts, maxAttempts)))
    .returning({ spotifyId: matchQueue.spotifyId });

  return {
    recovered: recovered.length,
    retried: retried.length,
    exhausted: exhausted.length,
  };
}

export async function processNextPendingAlbum(
  claimOwnerId: string,
  maxAttempts = 5,
): Promise<AlbumProcessResult | null> {
  const claim = await claimNextPendingAlbum(claimOwnerId, maxAttempts);
  if (!claim) return null;
  return processQueuedAlbum(claim.albumId, claimOwnerId, claim.trackIds);
}

// Small: each is a request and the pass has a five-minute ceiling; the chain continues while stubs
// remain.
const WORK_SWEEP_SIZE = 40;

/** After works: a work's title and tree are what a reader sees first. */
const ARTIST_SWEEP_SIZE = 20;

const RECORDING_SWEEP_SIZE = 30;

// Release caching runs on the interactive channel for every album touched; the work tree runs on
// backfill, in bounded slices, only when no albums are left.
export async function runMatchQueueWorker(
  options: {
    maxAlbums?: number;
    maxAttempts?: number;
    recover?: boolean;
    retryFailed?: boolean;
    staleMinutes?: number;
    musicbrainz?: boolean;
  } = {},
): Promise<QueueWorkerResult> {
  const maxAlbums = options.maxAlbums ?? 1;
  const maxAttempts = options.maxAttempts ?? 5;
  const prepared = options.recover
    ? await prepareMatchQueue({
        maxAttempts,
        staleMinutes: options.staleMinutes,
        retryFailed: options.retryFailed,
      })
    : { recovered: 0, retried: 0, exhausted: 0 };
  const albums: AlbumProcessResult[] = [];

  for (let index = 0; index < maxAlbums; index++) {
    const result = await processNextPendingAlbum(
      `queue-vercel-${crypto.randomUUID()}`,
      maxAttempts,
    );
    if (!result) break;
    albums.push(result);
  }

  const musicbrainz = {
    albumsCached: albums.filter((album) => album.musicbrainz?.releaseCached).length,
    tracksAnchored: albums.reduce((sum, album) => sum + (album.musicbrainz?.anchored ?? 0), 0),
    worksRead: 0,
    worksUnavailable: 0,
    recordingsRead: 0,
    artistsRead: 0,
    requests: albums.reduce((sum, album) => sum + (album.musicbrainz?.requests ?? 0), 0),
    stopped: null as string | null,
  };

  if (options.musicbrainz !== false) {
    const [
      { drainArtistStubs, drainRecordingStubs, drainWorkStubs },
      { musicBrainzApi },
      { MusicBrainzBudgetError },
    ] = await Promise.all([
      import('@/lib/musicbrainz-cache'),
      import('@/lib/musicbrainz'),
      import('@/lib/musicbrainz-gateway'),
    ]);

    try {
      if (albums.length === 0) {
        // Recordings first: a recording stub is a liked track reaching no work at all.
        const recordings = await drainRecordingStubs(
          musicBrainzApi('backfill'),
          RECORDING_SWEEP_SIZE,
        );
        musicbrainz.recordingsRead += recordings.recordings;
        musicbrainz.requests += recordings.requests;

        const swept =
          recordings.recordings > 0
            ? { works: 0, requests: 0, unavailable: 0 }
            : await drainWorkStubs(musicBrainzApi('backfill'), WORK_SWEEP_SIZE);
        musicbrainz.worksRead += swept.works;
        musicbrainz.worksUnavailable += swept.unavailable;
        musicbrainz.requests += swept.requests;

        if (recordings.recordings === 0 && swept.works === 0) {
          const artists = await drainArtistStubs(musicBrainzApi('backfill'), ARTIST_SWEEP_SIZE);
          musicbrainz.artistsRead += artists.artists;
          musicbrainz.requests += artists.requests;
        }
      }
    } catch (error) {
      // A paused gateway or exhausted cap is not the album's failure; reported so the chain stops,
      // not thrown.
      if (error instanceof MusicBrainzBudgetError) {
        musicbrainz.stopped = error.message;
      } else {
        console.error('MusicBrainz ingest failed:', error);
        musicbrainz.stopped = error instanceof Error ? error.message : String(error);
      }
    }
  }

  // Cheap invariants run per pass so a violation can't accumulate for days; a broken cache stops
  // the chain.
  let brokenInvariants: { name: string; violations: number }[] = [];
  if (options.musicbrainz !== false && albums.length > 0) {
    try {
      const { runMusicBrainzInvariants, recordInvariantResults, hardViolations } =
        await import('@/lib/musicbrainz-invariants');
      const results = await runMusicBrainzInvariants({ cheapOnly: true });
      await recordInvariantResults(results);
      brokenInvariants = hardViolations(results).map((result) => ({
        name: result.name,
        violations: result.violations,
      }));
      for (const broken of brokenInvariants) {
        console.error(`MusicBrainz cache invariant broken: ${broken.name} (${broken.violations})`);
      }
    } catch (error) {
      console.error('Invariant check failed:', error);
    }
  }

  return { albums, ...prepared, musicbrainz, brokenInvariants };
}

export async function claimPendingAlbum(
  albumId: string,
  claimOwnerId: string,
  maxAttempts?: number,
): Promise<ClaimedAlbum | null> {
  const rows = await db
    .update(matchQueue)
    .set({
      status: 'processing',
      attempts: sql`${matchQueue.attempts} + 1`,
      lastAttemptAt: now(),
      errorMessage: null,
      claimOwnerId,
    })
    .where(
      and(
        eq(matchQueue.spotifyAlbumId, albumId),
        eq(matchQueue.status, 'pending'),
        maxAttempts === undefined ? undefined : lt(matchQueue.attempts, maxAttempts),
      ),
    )
    .returning({ spotifyId: matchQueue.spotifyId });

  if (rows.length === 0) return null;
  return { albumId, trackIds: rows.map((row) => row.spotifyId) };
}

async function getProcessingTrackIds(albumId: string, claimOwnerId: string) {
  const rows = await db
    .select({ spotifyId: matchQueue.spotifyId })
    .from(matchQueue)
    .where(
      and(
        eq(matchQueue.spotifyAlbumId, albumId),
        eq(matchQueue.status, 'processing'),
        eq(matchQueue.claimOwnerId, claimOwnerId),
      ),
    );

  return rows.map((row) => row.spotifyId);
}

async function getAnchoredTrackIds(trackIds: string[]) {
  const rows = await forChunks(trackIds, (chunk) =>
    db
      .select({ spotifyTrackId: trackRecording.spotifyTrackId })
      .from(trackRecording)
      .where(inArray(trackRecording.spotifyTrackId, chunk)),
  );
  return new Set(rows.map((row) => row.spotifyTrackId));
}

// A track MusicBrainz can't place keeps the reason it gave, which the contribution console can act
// on. `recordAlbumPassOutcomes` owns the outcome → status mapping.
async function processAlbumThroughMusicBrainz(
  albumId: string,
  trackIds: string[],
  result: AlbumProcessResult,
  claimOwnerId: string,
  dependencies: AlbumPassDependencies = {},
): Promise<AlbumProcessResult> {
  const source =
    dependencies.musicBrainzSource ??
    (await import('@/lib/musicbrainz')).musicBrainzApi('interactive');
  const anchored = await getAnchoredTrackIds(trackIds);
  const report = await runMusicBrainzAlbumPass(source, albumId, trackIds, {
    alreadyAnchored: trackIds.length > 0 && trackIds.every((trackId) => anchored.has(trackId)),
    readAlbum: dependencies.readAlbum,
  });
  result.musicbrainz = {
    releaseCached: report.releaseMbid !== null,
    anchored: report.anchored,
    requests: report.requests,
  };
  await recordAlbumPassOutcomes(report.tracks, claimOwnerId);
  for (const outcome of report.tracks) {
    if (outcome.state === 'ready') result.matched++;
    else if (outcome.state === 'not_classical') result.notClassical++;
    else result.unresolved++;
  }

  return result;
}

/** Injectable so a test can run the real mapping without a network. */
export type AlbumPassDependencies = {
  readAlbum?: typeof getSpotifyAlbumTracks;
  musicBrainzSource?: MusicBrainzSource;
};

export async function processQueuedAlbum(
  albumId: string,
  claimOwnerId: string,
  trackIds: string[],
  dependencies: AlbumPassDependencies = {},
): Promise<AlbumProcessResult> {
  const result: AlbumProcessResult = {
    albumId,
    claimed: trackIds.length,
    matched: 0,
    failed: 0,
    notClassical: 0,
    unresolved: 0,
    errors: [],
  };

  if (trackIds.length === 0) return result;

  try {
    const { tracks } = await (dependencies.readAlbum ?? getSpotifyAlbumTracks)(albumId);
    const albumTracks = tracks.sort(compareTrackOrder);
    const albumTrackById = new Map(albumTracks.map((track) => [track.id, track]));
    const missingTrackIds = trackIds.filter((trackId) => !albumTrackById.has(trackId));

    if (missingTrackIds.length > 0) {
      await setQueueStatus(missingTrackIds, 'failed', {
        heldBy: claimOwnerId,
        errorMessage: 'Queued track was not found on its Spotify album',
      });
      result.errors.push(
        ...missingTrackIds.map((trackId) => ({
          trackId,
          message: 'Queued track was not found on its Spotify album',
        })),
      );
      result.failed += missingTrackIds.length;
    }

    const processableTrackIds = trackIds.filter((trackId) => albumTrackById.has(trackId));
    return await processAlbumThroughMusicBrainz(
      albumId,
      processableTrackIds,
      result,
      claimOwnerId,
      dependencies,
    );
  } catch (error) {
    const message = errorMessage(error, 'Failed to process album');
    const status = isRetryableProcessingError(message) ? 'pending' : 'failed';
    const activeTrackIds = await getProcessingTrackIds(albumId, claimOwnerId);

    await setQueueStatus(activeTrackIds, status, {
      heldBy: claimOwnerId,
      errorMessage: message,
    });
    result.errors.push({ message, retryable: status === 'pending' });
    if (status === 'failed') result.failed += activeTrackIds.length;
    return result;
  }
}
