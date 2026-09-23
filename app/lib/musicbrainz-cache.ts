/**
 * Writing MusicBrainz into our cache of it.
 *
 * These tables hold what MusicBrainz says, keyed by MBID, shared by every
 * user. Ingest is idempotent: re-reading a release rewrites its rows rather
 * than accumulating them, because the cache should converge on whatever
 * MusicBrainz currently says and never hold a mixture of two readings.
 *
 * The shape of the work is dictated by the request budget. One release read
 * brings back a whole album — tracklist, recordings, ISRCs, work names,
 * credits — and the only thing it cannot bring back is the work tree above
 * those names, because a work's parent is only visible from the work itself.
 * So: one request for the release, then one for each work we have never
 * looked at, and none at all for anything already cached.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './db';
import {
  mbArtist,
  mbCacheLookupMetric,
  mbImportRun,
  mbRecording,
  mbRecordingCredit,
  mbRecordingIsrc,
  mbRecordingWork,
  mbRelease,
  mbReleaseTrack,
  mbReleaseUrl,
  mbRequestOperationMetric,
  mbWork,
  mbWorkCatalogue,
} from './db/schema';
import type { MusicBrainzChannel } from './musicbrainz-budget';
import { cataloguesOf, composerOf, parentPartOf, yearOf } from './musicbrainz';
import { splitCatalogueReference } from './musicbrainz-catalogue';
import type { AnonymousImportRunInput } from './track-classification';
import type {
  MbArtist,
  MbRelease,
  MbReleaseRecording,
  MbWork,
  MusicBrainzSource,
} from './musicbrainz-source';

/** libSQL takes large statements, but not unbounded ones. */
const INSERT_CHUNK = 200;

/** A transaction or the root client; the cache writes through either. */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Collapse rows that would collide on their key before they reach SQLite. */
function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

function chunk<T>(items: T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ----------------------------------------------------------- metrics --- */

export type { AnonymousImportRunInput };

export type MarginalRequestPercentiles = {
  runs: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
};

function metricDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function channelFromSource(source: MusicBrainzSource): MusicBrainzChannel {
  const match = /^musicbrainz-api:(\w+)$/.exec(source.name);
  if (
    match &&
    (['interactive', 'backfill', 'bot'] as const).includes(match[1] as MusicBrainzChannel)
  ) {
    return match[1] as MusicBrainzChannel;
  }
  return 'backfill';
}

async function bumpCacheLookup(operation: string, hits: number, misses: number) {
  if (hits === 0 && misses === 0) return;
  const day = metricDay();
  const lookups = hits + misses;
  await db
    .insert(mbCacheLookupMetric)
    .values({ day, operation, lookups, hits, misses })
    .onConflictDoUpdate({
      target: [mbCacheLookupMetric.day, mbCacheLookupMetric.operation],
      set: {
        lookups: sql`${mbCacheLookupMetric.lookups} + ${lookups}`,
        hits: sql`${mbCacheLookupMetric.hits} + ${hits}`,
        misses: sql`${mbCacheLookupMetric.misses} + ${misses}`,
      },
    });
}

async function recordMusicBrainzRequest(source: MusicBrainzSource, operation: string, count = 1) {
  if (count <= 0) return;
  const day = metricDay();
  const channel = channelFromSource(source);
  await db
    .insert(mbRequestOperationMetric)
    .values({ day, channel, operation, requests: count })
    .onConflictDoUpdate({
      target: [
        mbRequestOperationMetric.day,
        mbRequestOperationMetric.channel,
        mbRequestOperationMetric.operation,
      ],
      set: {
        requests: sql`${mbRequestOperationMetric.requests} + ${count}`,
      },
    });
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? null;
}

/** Whether a release MBID is already present in the local cache. */
export async function releaseIsCached(releaseMbid: string): Promise<boolean> {
  const [row] = await db
    .select({ mbid: mbRelease.mbid })
    .from(mbRelease)
    .where(eq(mbRelease.mbid, releaseMbid))
    .limit(1);
  return Boolean(row);
}

/** Persist one anonymous import/worker pass for marginal-request analysis. */
export async function recordAnonymousImportRun(input: AnonymousImportRunInput): Promise<number> {
  const [row] = await db
    .insert(mbImportRun)
    .values({
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      inputTrackCount: input.inputTrackCount,
      classicalCount: input.classicalCount,
      uncertainCount: input.uncertainCount,
      notClassicalCount: input.notClassicalCount,
      unreviewedCount: input.unreviewedCount,
      albumsAlreadyCached: input.albumsAlreadyCached,
      albumsNew: input.albumsNew,
      requestsCaused: input.requestsCaused,
    })
    .returning({ id: mbImportRun.id });
  return row.id;
}

/** Rolling marginal MusicBrainz requests per import run. */
export async function marginalRequestPercentiles(
  sinceDays = 30,
): Promise<MarginalRequestPercentiles> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const rows = await db
    .select({ requestsCaused: mbImportRun.requestsCaused })
    .from(mbImportRun)
    .where(sql`${mbImportRun.completedAt} >= ${since.getTime()}`)
    .orderBy(mbImportRun.requestsCaused);
  const values = rows.map((row) => row.requestsCaused);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    runs: values.length,
    mean: values.length > 0 ? total / values.length : null,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
  };
}

/* ------------------------------------------------------------ entities --- */

async function cacheArtist(artist: MbArtist) {
  const row = {
    mbid: artist.id,
    name: artist.name,
    sortName: artist['sort-name'] ?? null,
    type: artist.type ?? null,
    beginYear: yearOf(artist['life-span']?.begin),
    endYear: yearOf(artist['life-span']?.end),
    fetchedAt: new Date(),
  };
  // `creditedName` is deliberately absent from the update: it is the name a
  // release printed, which this lookup does not know and must not erase.
  await db.insert(mbArtist).values(row).onConflictDoUpdate({
    target: mbArtist.mbid,
    set: row,
  });
}

/**
 * Record that a work exists and what it is called, without claiming to have
 * read it.
 *
 * A release names dozens of works and says nothing about their parents, so a
 * stub is all we know. It must never overwrite a work already fetched in
 * full — hence the do-nothing — or every release read would erase the tree
 * built by the work reads.
 */
async function cacheWorkStubs(
  works: { id: string; title: string; type?: string | null }[],
  executor: Transaction | typeof db = db,
) {
  const unique = new Map(works.map((work) => [work.id, work]));
  for (const batch of chunk([...unique.values()])) {
    await executor
      .insert(mbWork)
      .values(
        batch.map((work) => ({
          mbid: work.id,
          title: work.title,
          type: work.type ?? null,
          detail: 'stub' as const,
        })),
      )
      .onConflictDoNothing();
  }
}

/**
 * Store a work we have actually read: its parent, its position in that parent,
 * its composer and its catalogue references.
 *
 * Returns the parent's MBID so a caller can walk upwards without re-reading
 * the relations.
 */
async function cacheWork(work: MbWork): Promise<{ parentMbid: string | null }> {
  const parent = parentPartOf(work);
  const composer = composerOf(work);

  const row = {
    mbid: work.id,
    title: work.title,
    type: work.type ?? null,
    parentMbid: parent?.id ?? null,
    orderingKey: parent?.orderingKey ?? null,
    composerMbid: composer?.id ?? null,
    detail: 'full' as const,
    fetchedAt: new Date(),
  };
  await db.insert(mbWork).values(row).onConflictDoUpdate({ target: mbWork.mbid, set: row });

  if (parent) await cacheWorkStubs([{ id: parent.id, title: parent.title }]);
  if (composer) {
    await db
      .insert(mbArtist)
      .values({ mbid: composer.id, name: composer.name })
      .onConflictDoNothing();
  }

  const references = cataloguesOf(work).flatMap((catalogue) => {
    const split = splitCatalogueReference(catalogue.system, catalogue.number);
    return split ? [{ seriesMbid: catalogue.seriesId, ...split }] : [];
  });

  await db.delete(mbWorkCatalogue).where(eq(mbWorkCatalogue.workMbid, work.id));
  if (references.length > 0) {
    await db
      .insert(mbWorkCatalogue)
      .values(references.map((reference) => ({ workMbid: work.id, ...reference })))
      .onConflictDoNothing();
  }

  return { parentMbid: parent?.id ?? null };
}

/* ------------------------------------------------------------- release --- */

export type CachedRelease = {
  releaseMbid: string;
  tracks: number;
  recordings: number;
  credits: number;
  isrcs: number;
  /** Works named by this release, whether or not they were already known. */
  workMbids: string[];
};

async function cacheRelease(release: MbRelease): Promise<CachedRelease> {
  const recordings = new Map(release.tracks.map((track) => [track.recording.id, track.recording]));
  const recordingIds = [...recordings.values()].map((recording) => recording.id);

  const workLinks = dedupe(
    [...recordings.values()].flatMap((recording) =>
      recording.works.map((work) => ({ recordingMbid: recording.id, workMbid: work.id })),
    ),
    (row) => `${row.recordingMbid}:${row.workMbid}`,
  );

  const credits = dedupe(
    [...recordings.values()].flatMap((recording) =>
      recording.credits.map((credit) => ({
        recordingMbid: recording.id,
        artistMbid: credit.artistId,
        role: credit.role,
        instrument: credit.instrument ?? '',
      })),
    ),
    (row) => `${row.recordingMbid}:${row.artistMbid}:${row.role}:${row.instrument}`,
  );

  const isrcs = dedupe(
    [...recordings.values()].flatMap((recording) =>
      recording.isrcs.map((isrc) => ({ isrc, recordingMbid: recording.id })),
    ),
    (row) => `${row.isrc}:${row.recordingMbid}`,
  );

  const works = [...recordings.values()].flatMap((recording) => recording.works);

  /*
   * One transaction, because the tracklist, work links, credits and ISRCs are
   * rewritten rather than merged: each is deleted and reinserted so the cache
   * converges on what MusicBrainz currently says instead of holding a mixture
   * of two readings. Half of that applied is worse than none of it — a
   * release whose tracklist was deleted and not put back looks to every
   * invariant like a release with no tracks.
   */
  await db.transaction(async (tx) => {
    const fetchedAt = new Date();
    const releaseRow = {
      mbid: release.id,
      title: release.title,
      barcode: release.barcode,
      date: release.date,
      country: release.country,
      // An older mirror/test source may not implement URL relationships yet.
      // Omitting the marker preserves unknown; an explicit empty array from a
      // source that requested `url-rels` is authoritative absence.
      ...(release.urlRelations === undefined ? {} : { urlRelationsFetchedAt: fetchedAt }),
      fetchedAt,
    };
    await tx
      .insert(mbRelease)
      .values(releaseRow)
      .onConflictDoUpdate({ target: mbRelease.mbid, set: releaseRow });

    if (release.urlRelations !== undefined) {
      await tx.delete(mbReleaseUrl).where(eq(mbReleaseUrl.releaseMbid, release.id));
      for (const batch of chunk(release.urlRelations)) {
        await tx.insert(mbReleaseUrl).values(
          batch.map((relation) => ({
            releaseMbid: release.id,
            url: relation.url,
            relationshipType: relation.relationshipType,
            relationshipTypeId: relation.relationshipTypeId,
            ended: relation.ended,
            begin: relation.begin,
            end: relation.end,
            attributes: relation.attributes,
          })),
        );
      }
    }

    await tx.delete(mbReleaseTrack).where(eq(mbReleaseTrack.releaseMbid, release.id));
    for (const batch of chunk(release.tracks)) {
      await tx.insert(mbReleaseTrack).values(
        batch.map((track) => ({
          releaseMbid: release.id,
          medium: track.medium,
          position: track.position,
          recordingMbid: track.recording.id,
          title: track.title,
          length: track.length,
        })),
      );
    }

    // One statement per batch rather than one per recording: a box set is a
    // few hundred rows, and a round trip each made caching one a minute's work.
    for (const batch of chunk([...recordings.values()])) {
      await tx
        .insert(mbRecording)
        .values(
          batch.map((recording) => ({
            mbid: recording.id,
            title: recording.title,
            length: recording.length,
            detail: 'full' as const,
            fetchedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: mbRecording.mbid,
          set: {
            title: sql`excluded.title`,
            length: sql`excluded.length`,
            detail: sql`excluded.detail`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
    }

    for (const batch of chunk(recordingIds)) {
      await tx.delete(mbRecordingWork).where(inArray(mbRecordingWork.recordingMbid, batch));
      await tx.delete(mbRecordingCredit).where(inArray(mbRecordingCredit.recordingMbid, batch));
      await tx.delete(mbRecordingIsrc).where(inArray(mbRecordingIsrc.recordingMbid, batch));
    }

    for (const batch of chunk(workLinks)) {
      await tx.insert(mbRecordingWork).values(batch).onConflictDoNothing();
    }
    for (const batch of chunk(credits)) {
      await tx.insert(mbRecordingCredit).values(batch).onConflictDoNothing();
    }
    for (const batch of chunk(isrcs)) {
      await tx.insert(mbRecordingIsrc).values(batch).onConflictDoNothing();
    }

    await cacheArtistNames(tx, [...recordings.values()]);
    await cacheWorkStubs(works, tx);
  });

  return {
    releaseMbid: release.id,
    tracks: release.tracks.length,
    recordings: recordingIds.length,
    credits: credits.length,
    isrcs: isrcs.length,
    workMbids: [...new Set(works.map((work) => work.id))],
  };
}

/**
 * Artist names learned from a release: the relationship gives their
 * MusicBrainz name, the artist credit gives the name this release printed.
 */
async function cacheArtistNames(tx: Transaction, recordings: MbReleaseRecording[]) {
  const named = new Map<string, { name: string; creditedName: string | null }>();
  for (const recording of recordings) {
    for (const credit of recording.credits) {
      if (!named.has(credit.artistId)) {
        named.set(credit.artistId, { name: credit.name, creditedName: null });
      }
    }
    for (const credited of recording.artistCredit) {
      const existing = named.get(credited.artistId);
      if (existing) existing.creditedName ??= credited.name;
      else named.set(credited.artistId, { name: credited.name, creditedName: credited.name });
    }
  }

  for (const batch of chunk([...named])) {
    await tx
      .insert(mbArtist)
      .values(batch.map(([mbid, artist]) => ({ mbid, ...artist })))
      .onConflictDoUpdate({
        target: mbArtist.mbid,
        // Only fills a gap: a name we already learned is not replaced by a
        // later release crediting the same artist differently.
        set: { creditedName: sql`coalesce(${mbArtist.creditedName}, excluded.credited_name)` },
      });
  }
}

/* -------------------------------------------------------------- ingest --- */

/** Works we know the name of but have never read. */
export async function worksNeedingDetail(mbids: string[]): Promise<string[]> {
  if (mbids.length === 0) return [];
  const known = new Set<string>();
  let hits = 0;
  let misses = 0;
  for (const batch of chunk(mbids)) {
    const rows = await db
      .select({ mbid: mbWork.mbid })
      .from(mbWork)
      .where(and(inArray(mbWork.mbid, batch), eq(mbWork.detail, 'full')));
    for (const row of rows) known.add(row.mbid);
  }
  const pending = mbids.filter((mbid) => !known.has(mbid));
  hits = known.size;
  misses = pending.length;
  await bumpCacheLookup('work', hits, misses);
  return pending;
}

/**
 * How far up a work tree to walk.
 *
 * MusicBrainz trees are shallow in practice — a prelude inside a
 * prelude-and-fugue inside a book is three deep — so this is a guard against a
 * cycle or a pathological chain spending the day's budget, not a real limit.
 */
const MAX_TREE_DEPTH = 8;

/**
 * Read a work and everything above it, skipping what is already cached.
 *
 * Returns the number of requests spent, because that is the number the whole
 * design is judged on.
 */
export async function ingestWorkTree(
  source: MusicBrainzSource,
  workMbid: string,
): Promise<{ requests: number }> {
  let requests = 0;
  let next: string | null = workMbid;
  const seen = new Set<string>();

  for (let depth = 0; next && depth < MAX_TREE_DEPTH; depth++) {
    if (seen.has(next)) break;
    seen.add(next);

    const [needed] = await worksNeedingDetail([next]);
    if (!needed) {
      // Already read in full; its parent chain was read with it.
      break;
    }

    const work = await source.work(next);
    await recordMusicBrainzRequest(source, 'work');
    requests++;
    if (!work) break;

    const { parentMbid } = await cacheWork(work);
    next = parentMbid;
  }

  return { requests };
}

export type ReleaseIngestReport = {
  releaseMbid: string;
  found: boolean;
  requests: number;
  tracks: number;
  recordings: number;
  credits: number;
  isrcs: number;
  worksSeen: number;
  worksFetched: number;
};

/**
 * Bring one release, and the works it reaches, into the cache.
 *
 * The request count is the point of the shape: one for the release, then one
 * per work nobody has read yet. An album whose works are already cached — the
 * common case once a few users share a repertoire — costs exactly one.
 */
export async function ingestRelease(
  source: MusicBrainzSource,
  releaseMbid: string,
  options: { fetchWorks?: boolean } = {},
): Promise<ReleaseIngestReport> {
  const release = await source.releaseWithRecordings(releaseMbid);
  await recordMusicBrainzRequest(source, 'release');
  let requests = 1;

  if (!release) {
    return {
      releaseMbid,
      found: false,
      requests,
      tracks: 0,
      recordings: 0,
      credits: 0,
      isrcs: 0,
      worksSeen: 0,
      worksFetched: 0,
    };
  }

  const cached = await cacheRelease(release);
  const pending = options.fetchWorks === false ? [] : await worksNeedingDetail(cached.workMbids);
  let worksFetched = 0;

  for (const workMbid of pending) {
    const { requests: spent } = await ingestWorkTree(source, workMbid);
    requests += spent;
    if (spent > 0) worksFetched++;
  }

  return {
    releaseMbid,
    found: true,
    requests,
    tracks: cached.tracks,
    recordings: cached.recordings,
    credits: cached.credits,
    isrcs: cached.isrcs,
    worksSeen: cached.workMbids.length,
    worksFetched,
  };
}

/**
 * Re-read one recording: ISRCs, work links, credits.
 *
 * A Recheck of a work-relationship or contested-ISRC row has to ask MusicBrainz
 * again; the worker will not, once the track is already anchored.
 */
export async function ingestRecording(
  source: MusicBrainzSource,
  recordingMbid: string,
): Promise<{ found: boolean; requests: number }> {
  const detail = await source.recordingDetail(recordingMbid);
  await recordMusicBrainzRequest(source, 'recording');
  if (!detail) return { found: false, requests: 1 };

  const workLinks = dedupe(
    detail.works.map((work) => ({ recordingMbid: detail.id, workMbid: work.id })),
    (row) => `${row.recordingMbid}:${row.workMbid}`,
  );
  const isrcs = dedupe(
    detail.isrcs.map((isrc) => ({ isrc, recordingMbid: detail.id })),
    (row) => `${row.isrc}:${row.recordingMbid}`,
  );
  const credits = dedupe(
    detail.credits.map((credit) => ({
      recordingMbid: detail.id,
      artistMbid: credit.artistId,
      role: credit.role,
      instrument: credit.instrument ?? '',
    })),
    (row) => `${row.recordingMbid}:${row.artistMbid}:${row.role}:${row.instrument}`,
  );
  const fetchedAt = new Date();
  await db.transaction(async (tx) => {
    const row = {
      mbid: detail.id,
      title: detail.title,
      length: detail.length,
      detail: 'full' as const,
      fetchedAt,
    };
    await tx.insert(mbRecording).values(row).onConflictDoUpdate({
      target: mbRecording.mbid,
      set: row,
    });

    await tx.delete(mbRecordingWork).where(eq(mbRecordingWork.recordingMbid, detail.id));
    if (workLinks.length > 0) {
      await tx.insert(mbRecordingWork).values(workLinks);
    }

    await tx.delete(mbRecordingIsrc).where(eq(mbRecordingIsrc.recordingMbid, detail.id));
    if (isrcs.length > 0) {
      await tx.insert(mbRecordingIsrc).values(isrcs);
    }

    await tx.delete(mbRecordingCredit).where(eq(mbRecordingCredit.recordingMbid, detail.id));
    if (credits.length > 0) {
      await tx.insert(mbRecordingCredit).values(credits);
    }
  });

  if (detail.works.length > 0) await cacheWorkStubs(detail.works);
  if (detail.credits.length > 0) {
    await db
      .insert(mbArtist)
      .values(detail.credits.map((credit) => ({ mbid: credit.artistId, name: credit.name })))
      .onConflictDoNothing();
  }

  return { found: true, requests: 1 };
}

/**
 * Read recordings that an ISRC named but nobody has looked at.
 *
 * These come from the ISRC sweep, which resolves a track without knowing its
 * release and so learns nothing but an MBID. One request each turns that into
 * a title, a length, the works it performs and who played — the same
 * information a release read would have brought, for the albums MusicBrainz
 * does not have as releases.
 */
export async function drainRecordingStubs(
  source: MusicBrainzSource,
  limit: number,
): Promise<{ recordings: number; requests: number; reachedWork: number }> {
  const stubs = await db
    .select({ mbid: mbRecording.mbid })
    .from(mbRecording)
    .where(eq(mbRecording.detail, 'stub'))
    .limit(limit);

  let requests = 0;
  let recordings = 0;
  let reachedWork = 0;

  for (const stub of stubs) {
    await bumpCacheLookup('recording', 0, 1);
    const detail = await source.recordingDetail(stub.mbid);
    await recordMusicBrainzRequest(source, 'recording');
    requests++;
    if (!detail) continue;

    await db
      .update(mbRecording)
      .set({
        title: detail.title,
        length: detail.length,
        detail: 'full',
        fetchedAt: new Date(),
      })
      .where(eq(mbRecording.mbid, stub.mbid));

    if (detail.works.length > 0) {
      await db
        .insert(mbRecordingWork)
        .values(detail.works.map((w) => ({ recordingMbid: stub.mbid, workMbid: w.id })))
        .onConflictDoNothing();
      await cacheWorkStubs(detail.works);
      reachedWork++;
    }

    if (detail.credits.length > 0) {
      await db
        .insert(mbRecordingCredit)
        .values(
          detail.credits.map((c) => ({
            recordingMbid: stub.mbid,
            artistMbid: c.artistId,
            role: c.role,
            instrument: c.instrument ?? '',
          })),
        )
        .onConflictDoNothing();
      await db
        .insert(mbArtist)
        .values(detail.credits.map((c) => ({ mbid: c.artistId, name: c.name })))
        .onConflictDoNothing();
    }

    recordings++;
  }

  return { recordings, requests, reachedWork };
}

/**
 * Read works that a release named but nobody has looked at.
 *
 * This is the unbounded half of ingest, separated from the album-facing half
 * on purpose. Caching a release is one request and answers the question a
 * user is waiting on — which recordings are these? Reading the work tree
 * above them can be fifty requests for one compilation, and nobody is waiting
 * on it, so it belongs on the backfill channel where it can be starved
 * without anyone noticing.
 *
 * The stub rows are the queue: `mb_work.detail = 'stub'` means named but
 * never read, so there is no separate work list to keep in step.
 */
export async function drainWorkStubs(
  source: MusicBrainzSource,
  limit: number,
): Promise<{ works: number; requests: number }> {
  const stubs = await db
    .select({ mbid: mbWork.mbid })
    .from(mbWork)
    .where(eq(mbWork.detail, 'stub'))
    .limit(limit);

  let requests = 0;
  let works = 0;
  for (const stub of stubs) {
    const { requests: spent } = await ingestWorkTree(source, stub.mbid);
    requests += spent;
    if (spent > 0) works++;
  }
  return { works, requests };
}

/**
 * Re-read releases already cached, to pick up fields a later version of the
 * reader learned to ask for.
 *
 * Cheap in a way worth stating: the expensive half of ingest is the work
 * tree, and those works are already cached, so a re-read is one request per
 * release. That is what makes it reasonable to change what we store and
 * backfill it afterwards rather than getting it right first time.
 */
export async function refreshCachedReleases(
  source: MusicBrainzSource,
  limit: number,
): Promise<{ releases: number; requests: number }> {
  const releases = await db.select({ mbid: mbRelease.mbid }).from(mbRelease).limit(limit);
  let requests = 0;
  let refreshed = 0;
  for (const release of releases) {
    const report = await ingestRelease(source, release.mbid, { fetchWorks: false });
    requests += report.requests;
    if (report.found) refreshed++;
  }
  return { releases: refreshed, requests };
}

/**
 * Artists we know the name of but nothing else.
 *
 * Every artist reaches the cache as a stub — a name attached to a credit or a
 * composer relationship — because that is all a release read carries. Their
 * dates, sort name and type each cost a request, so they are filled in
 * afterwards and composers come first: a composer's dates are what place a
 * work in a period, which is a thing the reader shows, while a session
 * engineer's are not.
 */
async function artistsNeedingDetail(limit: number): Promise<string[]> {
  const composers = await db
    .selectDistinct({ mbid: mbArtist.mbid })
    .from(mbArtist)
    .innerJoin(mbWork, eq(mbWork.composerMbid, mbArtist.mbid))
    .where(isNull(mbArtist.sortName))
    .limit(limit);

  if (composers.length >= limit) return composers.map((row) => row.mbid);

  const rest = await db
    .select({ mbid: mbArtist.mbid })
    .from(mbArtist)
    .where(isNull(mbArtist.sortName))
    .limit(limit - composers.length);

  const seen = new Set(composers.map((row) => row.mbid));
  return [...seen, ...rest.map((row) => row.mbid).filter((mbid) => !seen.has(mbid))];
}

/**
 * Read artist stubs, composers first.
 *
 * One request each, and unlike works there is no tree to walk, so the cost is
 * exactly the number of artists nobody has looked at yet.
 */
export async function drainArtistStubs(
  source: MusicBrainzSource,
  limit: number,
): Promise<{ artists: number; requests: number }> {
  const pending = await artistsNeedingDetail(limit);
  let requests = 0;
  let artists = 0;

  for (const mbid of pending) {
    await bumpCacheLookup('artist', 0, 1);
    const artist = await source.artist(mbid);
    await recordMusicBrainzRequest(source, 'artist');
    requests++;
    if (!artist) continue;
    await cacheArtist(artist);
    artists++;
  }

  return { artists, requests };
}
