// The bulk crawl: finds Spotify albums for the releases our MusicBrainz tables hold, and puts each
// through the match queue the way a liked song's album goes (`enqueueReadAlbum`, then
// `processQueuedAlbum`), so there is one pipeline. It runs as a script, never on Vercel: the queue
// worker there leaves crawl rows alone.
//
// Spotify reads are batched (twenty albums, fifty tracks a request), and an album read here is
// handed to the pass, so the pass doesn't read it again.
//
// Resumable and idempotent: an album we hold or have queued is never read again, and every
// question asked of Spotify is recorded in `spotify_crawl` with its answer, including "none".
import type { Track } from '@spotify/web-api-ts-sdk';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { jsonList } from './db/chunked';
import { spotifyCrawl } from './db/schema';
import { normalizeIsrc } from './isrc';
import {
  CRAWL_SUBMITTER_PREFIX,
  claimPendingAlbum,
  enqueueReadAlbum,
  processQueuedAlbum,
  type AlbumProcessResult,
} from './match-queue-processor';
import { SPOTIFY_ALBUM_URL_PREFIX } from './musicbrainz-mirror';
import type { MusicBrainzSource } from './musicbrainz-source';
import type { SpotifyAlbumMetadata, SpotifyAlbumWithTrackIds } from './spotify-app-client';

export type SpotifyCrawlClient = {
  albums(ids: string[]): Promise<(SpotifyAlbumWithTrackIds | null)[]>;
  albumTrackIds(id: string): Promise<string[]>;
  tracks(ids: string[]): Promise<Track[]>;
  searchTracksByIsrc(isrc: string): Promise<Track[]>;
  /** Requests sent so far, for the progress line. */
  requests(): number;
};

export async function spotifyAppCrawlClient(): Promise<SpotifyCrawlClient> {
  const spotify = await import('./spotify-app-client');
  return {
    albums: spotify.getSpotifyAlbumsByIds,
    albumTrackIds: spotify.getSpotifyAlbumTrackIds,
    tracks: spotify.getSpotifyTracksByIds,
    searchTracksByIsrc: spotify.searchSpotifyTracksByIsrc,
    requests: spotify.spotifyRequestsSent,
  };
}

const MAX_ATTEMPTS = 5;

export type CrawlAlbumsResult = {
  /** Each album asked for that Spotify returned, under the ID Spotify gave it. */
  read: { requested: string; albumId: string }[];
  /** IDs Spotify has no album for. */
  missing: string[];
  processed: AlbumProcessResult[];
  /** Set by a retryable failure (a rate limit, a spent MusicBrainz budget): stop the run. */
  stopped: string | null;
  spotifyRequests: number;
  musicbrainzRequests: number;
};

export type CrawlDependencies = {
  client: SpotifyCrawlClient;
  musicBrainzSource: MusicBrainzSource;
};

/** Reads albums from Spotify in batches, queues their tracks, and runs the match pass on each. */
export async function crawlAlbums(
  albumIds: string[],
  submittedBy: string,
  { client, musicBrainzSource }: CrawlDependencies,
): Promise<CrawlAlbumsResult> {
  const before = client.requests();
  const result: CrawlAlbumsResult = {
    read: [],
    missing: [],
    processed: [],
    stopped: null,
    spotifyRequests: 0,
    musicbrainzRequests: 0,
  };
  const unique = [...new Set(albumIds)];
  if (unique.length === 0) return result;

  const albums = await client.albums(unique);
  const read: { album: SpotifyAlbumMetadata; trackIds: string[] }[] = [];
  for (const [index, album] of albums.entries()) {
    if (!album) {
      result.missing.push(unique[index]);
      continue;
    }
    const trackIds = album.moreTracks ? await client.albumTrackIds(album.id) : album.trackIds;
    read.push({ album, trackIds });
    result.read.push({ requested: unique[index], albumId: album.id });
  }

  // Fifty tracks a request across albums, rather than a request per album.
  const tracks = new Map(
    (await client.tracks(read.flatMap(({ trackIds }) => trackIds))).map((track) => [
      track.id,
      track,
    ]),
  );
  const prefetched = new Map(
    read.map(({ album, trackIds }) => [
      album.id,
      {
        album,
        tracks: trackIds.flatMap((id) => {
          const track = tracks.get(id);
          return track ? [track] : [];
        }),
      },
    ]),
  );

  const owner = `crawl-${crypto.randomUUID()}`;
  for (const { album, trackIds } of read) {
    await enqueueReadAlbum(album.id, album, trackIds, submittedBy);
  }
  for (const { album } of read) {
    const claim = await claimPendingAlbum(album.id, owner, MAX_ATTEMPTS);
    if (!claim) continue;
    const processed = await processQueuedAlbum(album.id, owner, claim.trackIds, {
      musicBrainzSource,
      // An album this batch read is not read again; anything else would be.
      readAlbum: async (id) => {
        const held = prefetched.get(id);
        if (held) return held;
        const spotify = await import('./spotify-app-client');
        return spotify.getSpotifyAlbumTracks(id);
      },
    });
    result.processed.push(processed);
    result.musicbrainzRequests += processed.musicbrainz?.requests ?? 0;
    const retryable = processed.errors.find((error) => error.retryable);
    if (retryable) {
      result.stopped = retryable.message;
      break;
    }
  }

  result.spotifyRequests = client.requests() - before;
  return result;
}

/** One batch from a walk: the albums to read, and how to record what reading them found. */
export type CrawlBatch = {
  /** How many of the walk's subjects (links, releases, search pages) this batch consumed. */
  subjects: number;
  albumIds: string[];
  /** Spotify requests the walk itself spent finding these albums (searches). */
  spotifyRequests: number;
  /** Records the batch once its albums are queued, so a crash before then repeats the batch. */
  settle(result: CrawlAlbumsResult): Promise<void>;
};

// A source of Spotify albums to crawl. The two below walk what MusicBrainz knows; a label or
// composer search walk (`label:"BIS"`, `artist:"Sibelius"`, paged through Spotify search and
// recorded in `spotify_crawl` under a kind of its own) would implement the same interface and run
// through `runCrawl` unchanged.
export interface CrawlWalk {
  readonly name: string;
  /** `submitted_by` on the queue rows it adds; starts with `crawl:`. */
  readonly submittedBy: string;
  /** Null when the walk has nothing left. */
  next(limit: number): Promise<CrawlBatch | null>;
}

const SPOTIFY_ALBUM_URL_END = `${SPOTIFY_ALBUM_URL_PREFIX.slice(0, -1)}0`;
const SPOTIFY_ALBUM_ID = /^https:\/\/open\.spotify\.com\/album\/([A-Za-z0-9]{22})$/;
const PAGE = 500;

/** Of these Spotify albums, the ones we hold or have queued already. */
async function heldOrQueued(albumIds: string[]): Promise<Set<string>> {
  if (albumIds.length === 0) return new Set();
  const rows = await db.all<{ id: string }>(sql`
    select spotify_id as id from spotify_album where spotify_id in (${jsonList(albumIds)})
    union
    select spotify_album_id from match_queue where spotify_album_id in (${jsonList(albumIds)})`);
  return new Set(rows.map((row) => row.id));
}

async function crawled(kind: 'mb_link' | 'isrc_search', subjects: string[]): Promise<Set<string>> {
  if (subjects.length === 0) return new Set();
  const rows = await db.all<{ subject: string }>(sql`
    select subject from spotify_crawl where kind = ${kind} and subject in (${jsonList(subjects)})`);
  return new Set(rows.map((row) => row.subject));
}

async function recordCrawl(rows: (typeof spotifyCrawl.$inferInsert)[]) {
  if (rows.length === 0) return;
  await db
    .insert(spotifyCrawl)
    .values(rows)
    .onConflictDoUpdate({
      target: [spotifyCrawl.kind, spotifyCrawl.subject],
      set: {
        isrcs: sql`excluded.isrcs`,
        albumIds: sql`excluded.album_ids`,
        outcome: sql`excluded.outcome`,
        requests: sql`excluded.requests`,
        checkedAt: sql`excluded.checked_at`,
      },
    });
}

/**
 * (a) Spotify albums MusicBrainz links a release to that we don't hold: the cheapest source, since
 * the link also names the release, and twenty albums cost one request.
 */
export function linkedAlbumWalk(): CrawlWalk {
  let cursor = SPOTIFY_ALBUM_URL_PREFIX;
  let done = false;
  return {
    name: 'links',
    submittedBy: `${CRAWL_SUBMITTER_PREFIX}mb-link`,
    async next(limit) {
      const wanted: string[] = [];
      while (!done && wanted.length < limit) {
        const page = await db.all<{ url: string }>(sql`
          select distinct url from mb_release_url
           where url > ${cursor} and url < ${SPOTIFY_ALBUM_URL_END} and ended = 0
           order by url limit ${PAGE}`);
        if (page.length < PAGE) done = true;
        if (page.length === 0) break;

        const ids: string[] = [];
        for (const { url } of page) {
          if (wanted.length + ids.length >= limit) break;
          cursor = url;
          // A link that is not a plain album URL names nothing we can read.
          const id = SPOTIFY_ALBUM_ID.exec(url)?.[1];
          if (id && !ids.includes(id) && !wanted.includes(id)) ids.push(id);
        }
        if (page.length > 0 && cursor !== page[page.length - 1].url) done = false;
        const [held, asked] = await Promise.all([heldOrQueued(ids), crawled('mb_link', ids)]);
        wanted.push(...ids.filter((id) => !held.has(id) && !asked.has(id)));
      }
      if (wanted.length === 0) return null;
      return {
        subjects: wanted.length,
        albumIds: wanted,
        spotifyRequests: 0,
        async settle(result) {
          const now = new Date();
          await recordCrawl([
            ...result.read.map(({ requested, albumId }) => ({
              kind: 'mb_link' as const,
              subject: requested,
              albumIds: [albumId],
              outcome: 'queued' as const,
              requests: 0,
              checkedAt: now,
            })),
            ...result.missing.map((requested) => ({
              kind: 'mb_link' as const,
              subject: requested,
              albumIds: [],
              outcome: 'not_found' as const,
              requests: 0,
              checkedAt: now,
            })),
          ]);
        },
      };
    },
  };
}

export type IsrcSearchCandidate = { releaseMbid: string; isrcs: string[] };

/** The first track's ISRC, and one from the middle in case Spotify files the first elsewhere. */
export function isrcsToSearch(tracks: { isrc: string }[]): string[] {
  const isrcs = [...new Set(tracks.map((track) => normalizeIsrc(track.isrc)).filter(Boolean))];
  if (isrcs.length <= 1) return isrcs;
  return [isrcs[0], isrcs[Math.floor(isrcs.length / 2)]];
}

/**
 * Releases holding ISRCs, with no Spotify link and no album of ours matched to them, not yet
 * searched. Keyset-paged by MBID from `after`.
 */
export async function isrcSearchCandidates(
  limit: number,
  after: string,
): Promise<{ candidates: IsrcSearchCandidate[]; cursor: string; done: boolean }> {
  const candidates: IsrcSearchCandidate[] = [];
  let cursor = after;
  for (;;) {
    const page = await db.all<{ mbid: string }>(sql`
      select r.mbid from mb_release r
       where r.mbid > ${cursor}
         and not exists (select 1 from mb_release_url u where u.release_mbid = r.mbid
               and u.url > ${SPOTIFY_ALBUM_URL_PREFIX} and u.url < ${SPOTIFY_ALBUM_URL_END}
               and u.ended = 0)
         and not exists (select 1 from spotify_album a where a.mb_release_id = r.mbid)
         and not exists (select 1 from spotify_crawl c
               where c.kind = 'isrc_search' and c.subject = r.mbid)
       order by r.mbid limit ${PAGE}`);
    if (page.length === 0) return { candidates, cursor, done: true };

    const tracks = await db.all<{ releaseMbid: string; isrc: string }>(sql`
      select t.release_mbid as releaseMbid, min(i.isrc) as isrc
        from mb_release_track t join mb_recording_isrc i on i.recording_mbid = t.recording_mbid
       where t.release_mbid in (${jsonList(page.map((row) => row.mbid))})
       group by t.release_mbid, t.medium, t.position
       order by t.release_mbid, t.medium, t.position`);
    const byRelease = new Map<string, { isrc: string }[]>();
    for (const track of tracks) {
      byRelease.set(track.releaseMbid, [...(byRelease.get(track.releaseMbid) ?? []), track]);
    }

    for (const { mbid } of page) {
      cursor = mbid;
      // A release without ISRCs has nothing to search by; it is passed over, not recorded.
      const isrcs = isrcsToSearch(byRelease.get(mbid) ?? []);
      if (isrcs.length > 0) candidates.push({ releaseMbid: mbid, isrcs });
      if (candidates.length >= limit) return { candidates, cursor, done: false };
    }
    if (page.length < PAGE) return { candidates, cursor, done: true };
  }
}

/**
 * (b) Releases with ISRCs but no Spotify link: Spotify search `isrc:` names the album. One request
 * a release, two when the first ISRC finds nothing.
 */
export function isrcSearchWalk(client: SpotifyCrawlClient): CrawlWalk {
  let cursor = '';
  let done = false;
  return {
    name: 'isrc',
    submittedBy: `${CRAWL_SUBMITTER_PREFIX}isrc-search`,
    async next(limit) {
      if (done) return null;
      const page = await isrcSearchCandidates(limit, cursor);
      cursor = page.cursor;
      done = page.done;
      if (page.candidates.length === 0) return null;

      // An ISRC already on a track we hold names an album we have; no search needed.
      const allIsrcs = page.candidates.flatMap((candidate) => candidate.isrcs);
      const heldRows = await db.all<{ isrc: string; albumId: string }>(sql`
        select distinct isrc, spotify_album_id as albumId from spotify_track
         where isrc in (${jsonList(allIsrcs)})`);
      const heldAlbums = new Map<string, string[]>();
      for (const row of heldRows) {
        heldAlbums.set(row.isrc, [...(heldAlbums.get(row.isrc) ?? []), row.albumId]);
      }

      const before = client.requests();
      const rows: (typeof spotifyCrawl.$inferInsert)[] = [];
      const found = new Set<string>();
      for (const { releaseMbid, isrcs } of page.candidates) {
        const held = isrcs.flatMap((isrc) => heldAlbums.get(isrc) ?? []);
        if (held.length > 0) {
          rows.push({
            kind: 'isrc_search',
            subject: releaseMbid,
            isrcs,
            albumIds: [...new Set(held)].sort(),
            outcome: 'held',
            requests: 0,
          });
          continue;
        }
        const searched: string[] = [];
        let albums: string[] = [];
        for (const isrc of isrcs) {
          searched.push(isrc);
          const hits = await client.searchTracksByIsrc(isrc);
          albums = [
            ...new Set(
              hits
                .filter((hit) => normalizeIsrc(hit.external_ids?.isrc) === isrc && hit.album?.id)
                .map((hit) => hit.album.id),
            ),
          ].sort();
          if (albums.length > 0) break;
        }
        albums.forEach((album) => found.add(album));
        rows.push({
          kind: 'isrc_search',
          subject: releaseMbid,
          isrcs: searched,
          albumIds: albums,
          outcome: albums.length > 0 ? 'found' : 'not_found',
          requests: searched.length,
        });
      }

      const already = await heldOrQueued([...found]);
      return {
        subjects: page.candidates.length,
        albumIds: [...found].filter((album) => !already.has(album)),
        spotifyRequests: client.requests() - before,
        async settle() {
          const now = new Date();
          await recordCrawl(rows.map((row) => ({ ...row, checkedAt: now })));
        },
      };
    },
  };
}

/** Albums a crawl queued but did not finish (a crash, a rate limit): finished first on a rerun. */
export function resumeWalk(): CrawlWalk {
  const seen = new Set<string>();
  return {
    name: 'resume',
    submittedBy: `${CRAWL_SUBMITTER_PREFIX}resume`,
    async next(limit) {
      const rows = await db.all<{ albumId: string }>(sql`
        select distinct spotify_album_id as albumId from match_queue
         where status = 'pending' and spotify_album_id is not null and attempts < ${MAX_ATTEMPTS}
           and substr(submitted_by, 1, ${CRAWL_SUBMITTER_PREFIX.length}) = ${CRAWL_SUBMITTER_PREFIX}
         limit ${limit + seen.size}`);
      // One try per run: an album still pending afterwards waits for the next run.
      const albumIds = rows.map((row) => row.albumId).filter((id) => !seen.has(id));
      if (albumIds.length === 0) return null;
      const batch = albumIds.slice(0, limit);
      batch.forEach((id) => seen.add(id));
      return {
        subjects: batch.length,
        albumIds: batch,
        spotifyRequests: 0,
        settle: async () => {},
      };
    },
  };
}

export type CrawlProgress = {
  walk: string;
  subjects: number;
  albumsRead: number;
  albumsMissing: number;
  tracksMatched: number;
  tracksUnresolved: number;
  tracksNotClassical: number;
  tracksFailed: number;
  spotifyRequests: number;
  musicbrainzRequests: number;
  elapsedMs: number;
  stopped: string | null;
};

/** Runs a walk until it is done, `limit` subjects are consumed, or a batch says stop. */
export async function runCrawl(
  walk: CrawlWalk,
  options: CrawlDependencies & {
    limit: number;
    batchSize: number;
    onBatch?: (progress: CrawlProgress) => void;
    /** Checked between batches; a broken invariant stops the run. */
    checkInvariants?: () => Promise<string | null>;
    invariantEvery?: number;
  },
): Promise<CrawlProgress> {
  const started = Date.now();
  const progress: CrawlProgress = {
    walk: walk.name,
    subjects: 0,
    albumsRead: 0,
    albumsMissing: 0,
    tracksMatched: 0,
    tracksUnresolved: 0,
    tracksNotClassical: 0,
    tracksFailed: 0,
    spotifyRequests: 0,
    musicbrainzRequests: 0,
    elapsedMs: 0,
    stopped: null,
  };

  let batches = 0;
  while (progress.subjects < options.limit) {
    let batch: CrawlBatch | null;
    let result: CrawlAlbumsResult;
    try {
      batch = await walk.next(Math.min(options.batchSize, options.limit - progress.subjects));
      if (!batch) break;
      result = await crawlAlbums(batch.albumIds, walk.submittedBy, options);
      await batch.settle(result);
    } catch (error) {
      // Spotify refusing for longer than a polite wait, or the database dropping out: nothing of
      // this batch was recorded, so a rerun repeats it.
      progress.stopped = error instanceof Error ? error.message : String(error);
      break;
    }

    progress.subjects += batch.subjects;
    progress.albumsRead += result.read.length;
    progress.albumsMissing += result.missing.length;
    for (const album of result.processed) {
      progress.tracksMatched += album.matched;
      progress.tracksUnresolved += album.unresolved;
      progress.tracksNotClassical += album.notClassical;
      progress.tracksFailed += album.failed;
    }
    progress.spotifyRequests += batch.spotifyRequests + result.spotifyRequests;
    progress.musicbrainzRequests += result.musicbrainzRequests;
    progress.elapsedMs = Date.now() - started;
    progress.stopped = result.stopped;
    options.onBatch?.({ ...progress });
    if (result.stopped) break;

    batches++;
    if (options.checkInvariants && batches % (options.invariantEvery ?? 10) === 0) {
      const broken = await options.checkInvariants();
      if (broken) {
        progress.stopped = broken;
        break;
      }
    }
  }
  progress.elapsedMs = Date.now() - started;
  return progress;
}
