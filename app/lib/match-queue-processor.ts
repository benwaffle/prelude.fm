import { db } from '@/lib/db';
import { composer, matchQueue, trackRecording, trackWorkPartV2 } from '@/lib/db/schema';
import {
  getSpotifyAlbumMetadata,
  getSpotifyAlbumTrackIds,
  getSpotifyAlbumTracks,
  getSpotifyTracksByIds,
  findSpotifyArtistByName,
  type SpotifyArtistMetadata,
} from '@/lib/spotify-app-client';
import { parseAlbumTracksV2, type ClassicalMetadata } from '@/lib/classical-parser';
import { saveTrackMetadataInternal, type TrackMetadataSaveInput } from '@/lib/track-metadata-save';
import { saveParsedAlbumV2 } from '@/lib/work-parts-v2';
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Track } from '@spotify/web-api-ts-sdk';
import { runMusicBrainzAlbumPass, type TrackPassOutcome } from '@/lib/musicbrainz-worker';

export type MatchQueueStatus = 'pending' | 'processing' | 'matched' | 'failed' | 'not_classical';

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
  errors: Array<{ trackId?: string; message: string; retryable?: boolean }>;
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
  /** What the MusicBrainz side of the pass did, when it ran. */
  musicbrainz: {
    albumsCached: number;
    tracksAnchored: number;
    worksRead: number;
    recordingsRead: number;
    artistsRead: number;
    requests: number;
    /** Set when the budget refused the pass, so a caller can stop chaining. */
    stopped: string | null;
  };
  /** Cache invariants that the pass broke, if any. Non-empty means stop. */
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

function normalizeArtistName(name: string) {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Pd}/gu, '-')
    .trim()
    .toLowerCase();
}

async function setQueueStatus(
  trackIds: string[],
  status: MatchQueueStatus,
  data: { claimOwnerId?: string | null; errorMessage?: string | null } = {},
) {
  if (trackIds.length === 0) return;

  await db
    .update(matchQueue)
    .set({
      status,
      processedAt: status === 'processing' || status === 'pending' ? null : now(),
      errorMessage: data.errorMessage ?? null,
      claimOwnerId: data.claimOwnerId ?? undefined,
    })
    .where(
      and(
        inArray(matchQueue.spotifyId, trackIds),
        data.claimOwnerId ? eq(matchQueue.claimOwnerId, data.claimOwnerId) : undefined,
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
        status: 'pending',
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

  if (row?.spotifyAlbumId) return row.spotifyAlbumId;

  const hydrated = await hydratePendingRowsWithoutAlbumIds();
  if (hydrated === 0) return null;

  const [hydratedRow] = await db
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

  return hydratedRow?.spotifyAlbumId ?? null;
}

export async function claimNextPendingAlbum(
  claimOwnerId?: string,
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

/**
 * How many work stubs a pass reads when the match queue is empty.
 *
 * Small, because each one is a request and the pass has a five-minute
 * ceiling. The chain carries on while stubs remain, so the sweep makes
 * progress without any one invocation trying to finish it.
 */
const WORK_SWEEP_SIZE = 40;

/**
 * How many artist stubs a pass reads once no works are waiting.
 *
 * After works, because a work's title and tree are what a reader sees first;
 * an artist's dates only decide which period a composer is filed under.
 */
const ARTIST_SWEEP_SIZE = 20;

/** How many ISRC-named recordings a pass reads when no album is waiting. */
const RECORDING_SWEEP_SIZE = 30;

/**
 * One pass of the worker: some albums, then MusicBrainz.
 *
 * The MusicBrainz side is deliberately split in two. Caching an album's
 * release is one request and answers what a waiting user asked — which
 * recordings are these — so it runs on the interactive channel for every
 * album the pass touched. Reading the work tree above those recordings can be
 * dozens of requests for one compilation and nobody is waiting on it, so it
 * happens only when there are no albums left to process, on the backfill
 * channel, in bounded slices.
 */
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
    albumsCached: 0,
    tracksAnchored: 0,
    worksRead: 0,
    recordingsRead: 0,
    artistsRead: 0,
    requests: 0,
    stopped: null as string | null,
  };

  if (options.musicbrainz !== false) {
    const [
      { ingestAlbum },
      { drainArtistStubs, drainRecordingStubs, drainWorkStubs },
      { musicBrainzApi },
      { MusicBrainzBudgetError },
    ] = await Promise.all([
      import('@/lib/musicbrainz-ingest'),
      import('@/lib/musicbrainz-cache'),
      import('@/lib/musicbrainz'),
      import('@/lib/musicbrainz-gateway'),
    ]);

    try {
      // The MusicBrainz-first pass has already read the release and the work
      // trees above it, so asking again would only spend requests.
      for (const album of musicBrainzFirstPipeline() ? [] : albums) {
        const report = await ingestAlbum(musicBrainzApi('interactive'), album.albumId, {
          fetchWorks: false,
        });
        musicbrainz.requests += report.requests;
        if (report.releaseMbid) musicbrainz.albumsCached++;
        musicbrainz.tracksAnchored += report.anchors?.anchored ?? 0;
      }

      if (albums.length === 0) {
        // Recordings first: a recording stub is a track somebody has liked
        // that currently reaches no work at all, where a work stub only
        // deepens a tree that already has leaves.
        const recordings = await drainRecordingStubs(
          musicBrainzApi('backfill'),
          RECORDING_SWEEP_SIZE,
        );
        musicbrainz.recordingsRead += recordings.recordings;
        musicbrainz.requests += recordings.requests;

        const swept =
          recordings.recordings > 0
            ? { works: 0, requests: 0 }
            : await drainWorkStubs(musicBrainzApi('backfill'), WORK_SWEEP_SIZE);
        musicbrainz.worksRead += swept.works;
        musicbrainz.requests += swept.requests;

        if (recordings.recordings === 0 && swept.works === 0) {
          const artists = await drainArtistStubs(musicBrainzApi('backfill'), ARTIST_SWEEP_SIZE);
          musicbrainz.artistsRead += artists.artists;
          musicbrainz.requests += artists.requests;
        }
      }
    } catch (error) {
      // A paused gateway or an exhausted daily cap is not a failure of the
      // album: the classical metadata was still saved. It does mean there is
      // no point chaining another pass, so it is reported rather than thrown.
      if (error instanceof MusicBrainzBudgetError) {
        musicbrainz.stopped = error.message;
      } else {
        console.error('MusicBrainz ingest failed:', error);
        musicbrainz.stopped = error instanceof Error ? error.message : String(error);
      }
    }
  }

  // The cheap invariants run here rather than only in a nightly sweep,
  // because a service ingesting continuously can accumulate a violation for
  // days before anyone types a command. A broken cache stops the chain: the
  // classical metadata this pass saved is fine, but writing more on top of an
  // inconsistent cache makes the damage harder to understand.
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
  claimOwnerId?: string,
  maxAttempts?: number,
): Promise<ClaimedAlbum | null> {
  await db
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
    );

  const rows = await db
    .select({ spotifyId: matchQueue.spotifyId })
    .from(matchQueue)
    .where(
      and(
        eq(matchQueue.spotifyAlbumId, albumId),
        eq(matchQueue.status, 'processing'),
        claimOwnerId ? eq(matchQueue.claimOwnerId, claimOwnerId) : undefined,
      ),
    );

  if (rows.length === 0) return null;

  return {
    albumId,
    trackIds: rows.map((row) => row.spotifyId),
  };
}

async function getProcessingTrackIds(albumId: string, claimOwnerId?: string) {
  const rows = await db
    .select({ spotifyId: matchQueue.spotifyId })
    .from(matchQueue)
    .where(
      and(
        eq(matchQueue.spotifyAlbumId, albumId),
        eq(matchQueue.status, 'processing'),
        claimOwnerId ? eq(matchQueue.claimOwnerId, claimOwnerId) : undefined,
      ),
    );

  return rows.map((row) => row.spotifyId);
}

/**
 * Whether new intake goes through MusicBrainz rather than a language model.
 *
 * Read per call rather than at import, so the switch takes effect on the
 * next invocation of a long-lived worker instead of at the next deploy.
 */
export function musicBrainzFirstPipeline(): boolean {
  return process.env.PIPELINE === 'musicbrainz';
}

/** Tracks already anchored to a MusicBrainz recording. */
async function getAnchoredTrackIds(trackIds: string[]) {
  if (trackIds.length === 0) return new Set<string>();
  const rows: string[] = [];
  for (let start = 0; start < trackIds.length; start += 400) {
    const batch = trackIds.slice(start, start + 400);
    const found = await db
      .select({ spotifyTrackId: trackRecording.spotifyTrackId })
      .from(trackRecording)
      .where(inArray(trackRecording.spotifyTrackId, batch));
    rows.push(...found.map((row) => row.spotifyTrackId));
  }
  return new Set(rows);
}

/**
 * An album pass with MusicBrainz as the authority.
 *
 * Nothing is asserted that MusicBrainz did not say. A track it cannot place
 * is recorded as failed with the reason in the message — "no MusicBrainz
 * release carries this album's barcode" — which is a state the contribution
 * console can act on, unlike a composer somebody made up.
 *
 * `failed` is the wrong word for "MusicBrainz has not catalogued this yet",
 * and the queue has no better one until the pipeline-completion columns
 * land. The reason string carries the truth in the meantime, and this is
 * the single place that maps an outcome to a status.
 */
async function processAlbumThroughMusicBrainz(
  albumId: string,
  trackIds: string[],
  result: AlbumProcessResult,
  claimOwnerId?: string,
): Promise<AlbumProcessResult> {
  const { musicBrainzApi } = await import('@/lib/musicbrainz');
  const anchored = await getAnchoredTrackIds(trackIds);
  const report = await runMusicBrainzAlbumPass(musicBrainzApi('interactive'), albumId, trackIds, {
    alreadyAnchored: trackIds.length > 0 && trackIds.every((trackId) => anchored.has(trackId)),
  });

  const byState = new Map<TrackPassOutcome['state'], TrackPassOutcome[]>();
  for (const outcome of report.tracks) {
    byState.set(outcome.state, [...(byState.get(outcome.state) ?? []), outcome]);
  }

  const ready = byState.get('ready') ?? [];
  if (ready.length > 0) {
    await setQueueStatus(
      ready.map((outcome) => outcome.spotifyTrackId),
      'matched',
      { claimOwnerId },
    );
    result.matched += ready.length;
  }

  const notClassical = byState.get('not_classical') ?? [];
  if (notClassical.length > 0) {
    await setQueueStatus(
      notClassical.map((outcome) => outcome.spotifyTrackId),
      'not_classical',
      { claimOwnerId },
    );
    result.notClassical += notClassical.length;
  }

  for (const outcome of [
    ...(byState.get('unanchored') ?? []),
    ...(byState.get('unclassified') ?? []),
  ]) {
    await setQueueStatus([outcome.spotifyTrackId], 'failed', {
      claimOwnerId,
      errorMessage: outcome.reason,
    });
    result.failed++;
    result.errors.push({ trackId: outcome.spotifyTrackId, message: outcome.reason });
  }

  return result;
}

async function getLinkedTrackIds(trackIds: string[]) {
  if (trackIds.length === 0) return new Set<string>();

  const linkedRows = await db
    .select({ spotifyTrackId: trackWorkPartV2.spotifyTrackId })
    .from(trackWorkPartV2)
    .where(inArray(trackWorkPartV2.spotifyTrackId, trackIds));

  return new Set(linkedRows.map((row) => row.spotifyTrackId));
}

async function prepareParsedTrackSave(
  album: Awaited<ReturnType<typeof getSpotifyAlbumTracks>>['album'],
  track: Track,
  metadata: ClassicalMetadata,
  movementNumber: number,
): Promise<TrackMetadataSaveInput> {
  let composerName = metadata.composerName?.trim();
  const formalName = metadata.formalName.trim();

  if (!metadata.isClassical) throw new Error('Cannot save non-classical metadata');
  if (!composerName || !formalName) {
    throw new Error('Parsed metadata is missing composer or work title');
  }

  const parsedComposerNames = composerName
    .split(/\s+(?:&|and)\s+/iu)
    .map((name) => normalizeArtistName(name));
  const creditedComposerArtist = track.artists.find((artist) =>
    parsedComposerNames.includes(normalizeArtistName(artist.name)),
  );
  if (creditedComposerArtist) composerName = creditedComposerArtist.name;
  let composerArtist: SpotifyArtistMetadata | undefined = creditedComposerArtist
    ? { id: creditedComposerArtist.id, name: creditedComposerArtist.name }
    : undefined;

  if (!composerArtist) {
    const [existingComposer] = await db
      .select({ spotifyArtistId: composer.spotifyArtistId })
      .from(composer)
      .where(sql`lower(trim(${composer.name})) = ${composerName.toLowerCase()}`)
      .limit(1);

    if (existingComposer?.spotifyArtistId) {
      composerArtist = { id: existingComposer.spotifyArtistId, name: composerName };
    } else {
      const surname = composerName
        .trim()
        .split(/\s+/)
        .at(-1)
        ?.replace(/[^\p{L}\p{N}-]/gu, '')
        .toLowerCase();
      const surnameMatches = surname
        ? await db
            .select({ name: composer.name, spotifyArtistId: composer.spotifyArtistId })
            .from(composer)
            .where(sql`lower(${composer.name}) like ${`%${surname}%`}`)
            .limit(2)
        : [];
      const uniqueSurnameMatch =
        surnameMatches.length === 1 && surnameMatches[0].spotifyArtistId
          ? surnameMatches[0]
          : undefined;

      composerArtist = uniqueSurnameMatch
        ? { id: uniqueSurnameMatch.spotifyArtistId!, name: uniqueSurnameMatch.name }
        : ((await findSpotifyArtistByName(composerName)) ?? undefined);
    }
  }

  if (!composerArtist) {
    throw new Error(`Could not resolve Spotify artist for composer "${composerName}"`);
  }

  return {
    preserveExistingWork: true,
    album: {
      id: album.id,
      name: album.name,
      release_date: album.release_date,
      popularity: album.popularity,
      images: album.images,
      inSpotifyAlbumsTable: false,
    },
    track: {
      id: track.id,
      name: track.name,
      uri: track.uri,
      duration_ms: track.duration_ms,
      disc_number: track.disc_number,
      track_number: track.track_number,
      popularity: track.popularity,
      inSpotifyTracksTable: false,
      isrc: track.external_ids?.isrc ?? null,
    },
    artists: track.artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      inSpotifyArtistsTable: false,
    })),
    composerArtist: {
      id: composerArtist.id,
      name: composerArtist.name,
    },
    metadata: {
      composerArtistId: composerArtist.id,
      composerName,
      formalName,
      nickname: metadata.nickname || null,
      catalogSystem: metadata.catalogSystem || null,
      catalogNumber: metadata.catalogNumber || null,
      form: metadata.form || null,
      movementNumber,
      movementName: metadata.movementName || null,
      yearComposed: metadata.yearComposed || null,
    },
  };
}

export async function processQueuedAlbum(
  albumId: string,
  claimOwnerId?: string,
  claimedTrackIds?: string[],
): Promise<AlbumProcessResult> {
  let trackIdsToProcess = claimedTrackIds;

  if (!trackIdsToProcess) {
    await db
      .update(matchQueue)
      .set({
        status: 'processing',
        attempts: sql`${matchQueue.attempts} + 1`,
        lastAttemptAt: now(),
        errorMessage: null,
        claimOwnerId,
      })
      .where(and(eq(matchQueue.spotifyAlbumId, albumId), eq(matchQueue.status, 'pending')));

    trackIdsToProcess = await getProcessingTrackIds(albumId, claimOwnerId);
  } else if (claimOwnerId) {
    await db
      .update(matchQueue)
      .set({ claimOwnerId })
      .where(inArray(matchQueue.spotifyId, trackIdsToProcess));
  }

  const trackIds = trackIdsToProcess;
  const result: AlbumProcessResult = {
    albumId,
    claimed: trackIds.length,
    matched: 0,
    failed: 0,
    notClassical: 0,
    errors: [],
  };

  if (trackIds.length === 0) return result;

  try {
    const { album, tracks } = await getSpotifyAlbumTracks(albumId);
    const albumTracks = tracks.sort(compareTrackOrder);
    const albumTrackById = new Map(albumTracks.map((track) => [track.id, track]));
    const missingTrackIds = trackIds.filter((trackId) => !albumTrackById.has(trackId));

    if (missingTrackIds.length > 0) {
      await setQueueStatus(missingTrackIds, 'failed', {
        claimOwnerId,
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
    if (musicBrainzFirstPipeline()) {
      return await processAlbumThroughMusicBrainz(
        albumId,
        processableTrackIds,
        result,
        claimOwnerId,
      );
    }
    const linkedTrackIds = await getLinkedTrackIds(processableTrackIds);
    const alreadyLinkedTrackIds = processableTrackIds.filter((trackId) =>
      linkedTrackIds.has(trackId),
    );

    if (alreadyLinkedTrackIds.length > 0) {
      await setQueueStatus(alreadyLinkedTrackIds, 'matched', { claimOwnerId });
      result.matched += alreadyLinkedTrackIds.length;
    }

    const unknownTracks = processableTrackIds
      .filter((trackId) => !linkedTrackIds.has(trackId))
      .map((trackId) => albumTrackById.get(trackId)!)
      .sort(compareTrackOrder);

    if (unknownTracks.length === 0) return result;

    {
      const parsedV2 = await parseAlbumTracksV2(
        album.name,
        unknownTracks.map((track) => ({
          trackName: track.name,
          artistNames: track.artists.map((artist) => artist.name),
          discNumber: track.disc_number,
          trackNumber: track.track_number,
        })),
      );
      const synthesizedPartTrackIds = new Set<string>();
      const prepared: Array<{
        track: Track;
        metadata: (typeof parsedV2)[number];
        input: TrackMetadataSaveInput;
      }> = [];
      for (let index = 0; index < unknownTracks.length; index++) {
        const track = unknownTracks[index];
        const metadata = parsedV2[index];
        if (!metadata?.isClassical) {
          await setQueueStatus([track.id], 'not_classical', { claimOwnerId });
          result.notClassical++;
          continue;
        }
        if (metadata.parts.length === 0) {
          metadata.parts = [{ position: 1, label: null, title: metadata.formalName }];
          synthesizedPartTrackIds.add(track.id);
        }
        const firstPart = metadata.parts[0];
        const legacyMetadata: ClassicalMetadata = {
          isClassical: true,
          composerName: metadata.composerName,
          formalName: metadata.formalName,
          nickname: metadata.nickname,
          catalogSystem: metadata.catalogSystem,
          catalogNumber: metadata.catalogNumber,
          form: metadata.form,
          movement: firstPart.position,
          movementName: firstPart.title,
          yearComposed: metadata.yearComposed,
        };
        try {
          const input = await prepareParsedTrackSave(
            album,
            track,
            legacyMetadata,
            firstPart.position,
          );
          prepared.push({ track, metadata, input });
        } catch (error) {
          await setQueueStatus([track.id], 'failed', {
            claimOwnerId,
            errorMessage: errorMessage(error, 'Failed to save v2 base metadata'),
          });
          result.failed++;
        }
      }
      const eligibleTracks = prepared.map((item) => item.track);
      const eligibleTrackIds = eligibleTracks.map((track) => track.id);
      // One transaction for the base save and the v2 reconciliation: an album
      // whose work assignments do not all resolve must leave no rows behind.
      await db.transaction(async (transaction) => {
        for (const item of prepared) {
          await saveTrackMetadataInternal(item.input, transaction);
        }
        await saveParsedAlbumV2(
          album.id,
          eligibleTracks.map((track) => ({
            id: track.id,
            discNumber: track.disc_number,
            trackNumber: track.track_number,
          })),
          prepared.map((item) => item.metadata),
          transaction,
        );
        if (eligibleTrackIds.length > 0) {
          await transaction
            .update(trackWorkPartV2)
            .set({ matchStatus: 'needs_review' })
            .where(
              and(
                inArray(trackWorkPartV2.spotifyTrackId, eligibleTrackIds),
                eq(trackWorkPartV2.matchSource, 'manual'),
              ),
            );
        }
        if (synthesizedPartTrackIds.size > 0) {
          await transaction
            .update(trackWorkPartV2)
            .set({ matchStatus: 'needs_review' })
            .where(inArray(trackWorkPartV2.spotifyTrackId, [...synthesizedPartTrackIds]));
        }
      });
      const completedTrackIds = await getLinkedTrackIds(eligibleTrackIds);
      if (completedTrackIds.size > 0) {
        await setQueueStatus([...completedTrackIds], 'matched', { claimOwnerId });
        result.matched += completedTrackIds.size;
      }
      return result;
    }
  } catch (error) {
    const message = errorMessage(error, 'Failed to process album');
    const status = isRetryableProcessingError(message) ? 'pending' : 'failed';
    const activeTrackIds = await getProcessingTrackIds(albumId, claimOwnerId);

    await setQueueStatus(activeTrackIds, status, {
      claimOwnerId,
      errorMessage: message,
    });
    result.errors.push({ message, retryable: status === 'pending' });
    if (status === 'failed') result.failed += activeTrackIds.length;
    return result;
  }
}
