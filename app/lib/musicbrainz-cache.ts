// Ingest is idempotent: re-reading a release rewrites its rows so the cache converges on what
// MusicBrainz says now. One request per release, then one per work never read; a work's parent is
// only visible from the work itself.
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { db } from './db';
import { chunksOf } from './db/chunked';
import {
  mbArtist,
  mbRecording,
  mbRecordingCredit,
  mbRecordingIsrc,
  mbRecordingWork,
  mbRelease,
  mbReleaseTrack,
  mbReleaseUrl,
  mbWork,
  mbWorkCatalogue,
  spotifyArtist,
} from './db/schema';
import { bumpCacheLookup, recordMusicBrainzRequest } from './musicbrainz-cache-metrics';
import { normalizeIsrc } from './isrc';
import { cataloguesOf, composerOf, parentPartOf, spotifyArtistIdsOf, yearOf } from './musicbrainz';
import { splitCatalogueReference } from './musicbrainz-catalogue';
import type {
  MbArtist,
  MbRelease,
  MbReleaseRecording,
  MbWork,
  MusicBrainzSource,
} from './musicbrainz-source';

/** libSQL takes large statements, but not unbounded ones. */
const INSERT_CHUNK = 200;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

export async function releaseIsCached(releaseMbid: string): Promise<boolean> {
  const [row] = await db
    .select({ mbid: mbRelease.mbid })
    .from(mbRelease)
    .where(eq(mbRelease.mbid, releaseMbid))
    .limit(1);
  return Boolean(row);
}

// The Spotify page our tracks credit, so its portrait is one we hold; the first link when none is.
async function heldSpotifyArtistId(artist: MbArtist): Promise<string | null> {
  const linked = spotifyArtistIdsOf(artist);
  if (linked.length <= 1) return linked[0] ?? null;
  const held = await db
    .select({ id: spotifyArtist.spotifyId, images: spotifyArtist.images })
    .from(spotifyArtist)
    .where(inArray(spotifyArtist.spotifyId, linked));
  const withPortrait = held.find((row) => row.images?.length);
  return withPortrait?.id ?? held[0]?.id ?? linked[0];
}

async function cacheArtist(artist: MbArtist) {
  const now = new Date();
  const row = {
    mbid: artist.id,
    name: artist.name,
    sortName: artist['sort-name'] ?? null,
    type: artist.type ?? null,
    beginYear: yearOf(artist['life-span']?.begin),
    endYear: yearOf(artist['life-span']?.end),
    spotifyArtistId: await heldSpotifyArtistId(artist),
    linksReadAt: now,
    fetchedAt: now,
  };
  // `creditedName` is deliberately not updated: it is the name a release printed, which this lookup
  // does not know.
  await db.insert(mbArtist).values(row).onConflictDoUpdate({
    target: mbArtist.mbid,
    set: row,
  });
}

/** A stub must never overwrite a fully fetched work, hence the do-nothing. */
async function cacheWorkStubs(
  works: { id: string; title: string; type?: string | null }[],
  executor: Transaction | typeof db = db,
) {
  const unique = new Map(works.map((work) => [work.id, work]));
  for (const batch of chunksOf([...unique.values()], INSERT_CHUNK)) {
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
  const references = cataloguesOf(work).flatMap((catalogue) => {
    const split = splitCatalogueReference(catalogue.system, catalogue.number);
    return split ? [{ seriesMbid: catalogue.seriesId, ...split }] : [];
  });

  // One batch, so the catalogue references are never left deleted and not yet put back.
  const statements: BatchItem<'sqlite'>[] = [];
  if (parent) {
    statements.push(
      db
        .insert(mbWork)
        .values({ mbid: parent.id, title: parent.title, type: null, detail: 'stub' })
        .onConflictDoNothing(),
    );
  }
  if (composer) {
    statements.push(
      db.insert(mbArtist).values({ mbid: composer.id, name: composer.name }).onConflictDoNothing(),
    );
  }
  statements.push(db.delete(mbWorkCatalogue).where(eq(mbWorkCatalogue.workMbid, work.id)));
  if (references.length > 0) {
    statements.push(
      db
        .insert(mbWorkCatalogue)
        .values(references.map((reference) => ({ workMbid: work.id, ...reference })))
        .onConflictDoNothing(),
    );
  }
  await db.batch([
    db.insert(mbWork).values(row).onConflictDoUpdate({ target: mbWork.mbid, set: row }),
    ...statements,
  ]);

  return { parentMbid: parent?.id ?? null };
}

export type CachedRelease = {
  releaseMbid: string;
  tracks: number;
  recordings: number;
  credits: number;
  isrcs: number;
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
      recording.isrcs.map((isrc) => ({ isrc: normalizeIsrc(isrc), recordingMbid: recording.id })),
    ),
    (row) => `${row.isrc}:${row.recordingMbid}`,
  );

  const works = [...recordings.values()].flatMap((recording) => recording.works);

  // One transaction: rows are deleted and reinserted, and a half-applied rewrite looks like a
  // release with no tracks.
  await db.transaction(async (tx) => {
    const fetchedAt = new Date();
    const releaseRow = {
      mbid: release.id,
      title: release.title,
      barcode: release.barcode,
      date: release.date,
      country: release.country,
      // An older mirror/test source may not implement URL relationships: omitting the marker
      // preserves unknown, while an explicit empty array from a `url-rels` request is authoritative
      // absence.
      ...(release.urlRelations === undefined ? {} : { urlRelationsFetchedAt: fetchedAt }),
      fetchedAt,
    };
    await tx
      .insert(mbRelease)
      .values(releaseRow)
      .onConflictDoUpdate({ target: mbRelease.mbid, set: releaseRow });

    if (release.urlRelations !== undefined) {
      await tx.delete(mbReleaseUrl).where(eq(mbReleaseUrl.releaseMbid, release.id));
      for (const batch of chunksOf(release.urlRelations, INSERT_CHUNK)) {
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
    for (const batch of chunksOf(release.tracks, INSERT_CHUNK)) {
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

    // One statement per batch: a round trip per recording made caching a box set a minute's work.
    for (const batch of chunksOf([...recordings.values()], INSERT_CHUNK)) {
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

    for (const batch of chunksOf(recordingIds, INSERT_CHUNK)) {
      await tx.delete(mbRecordingWork).where(inArray(mbRecordingWork.recordingMbid, batch));
      await tx.delete(mbRecordingCredit).where(inArray(mbRecordingCredit.recordingMbid, batch));
      await tx.delete(mbRecordingIsrc).where(inArray(mbRecordingIsrc.recordingMbid, batch));
    }

    for (const batch of chunksOf(workLinks, INSERT_CHUNK)) {
      await tx.insert(mbRecordingWork).values(batch).onConflictDoNothing();
    }
    for (const batch of chunksOf(credits, INSERT_CHUNK)) {
      await tx.insert(mbRecordingCredit).values(batch).onConflictDoNothing();
    }
    for (const batch of chunksOf(isrcs, INSERT_CHUNK)) {
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

  for (const batch of chunksOf([...named], INSERT_CHUNK)) {
    await tx
      .insert(mbArtist)
      .values(batch.map(([mbid, artist]) => ({ mbid, ...artist })))
      .onConflictDoUpdate({
        target: mbArtist.mbid,
        // Only fills a gap: a later release crediting the artist differently does not replace it.
        set: { creditedName: sql`coalesce(${mbArtist.creditedName}, excluded.credited_name)` },
      });
  }
}

export async function worksNeedingDetail(mbids: string[]): Promise<string[]> {
  if (mbids.length === 0) return [];
  const known = new Set<string>();
  let hits = 0;
  let misses = 0;
  for (const batch of chunksOf(mbids, INSERT_CHUNK)) {
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

// A guard against cycles or pathological chains spending the day's budget; real trees are about
// three deep.
const MAX_TREE_DEPTH = 8;

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

export async function readAndCacheWork(
  source: MusicBrainzSource,
  workMbid: string,
): Promise<MbWork | null> {
  const work = await source.work(workMbid);
  await recordMusicBrainzRequest(source, 'work');
  if (work) await cacheWork(work);
  return work;
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

/** An album whose works are already cached costs exactly one request. */
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

/** Recheck needs this: the worker won't re-read an already-anchored track. */
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
    detail.isrcs.map((isrc) => ({ isrc: normalizeIsrc(isrc), recordingMbid: detail.id })),
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

/** The ISRC sweep learns only an MBID; one request each fills in what a release read would have. */
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

// Separate from release ingest so it can run on the backfill channel. `mb_work.detail = 'stub'` is
// the queue. A stub MusicBrainz won't return as itself (removed or merged) stays a stub, but
// `fetched_at` moves so the next slice doesn't keep re-asking the same works.
export async function drainWorkStubs(
  source: MusicBrainzSource,
  limit: number,
): Promise<{ works: number; requests: number; unavailable: number }> {
  const stubs = await db
    .select({ mbid: mbWork.mbid })
    .from(mbWork)
    .where(eq(mbWork.detail, 'stub'))
    .orderBy(asc(mbWork.fetchedAt), asc(mbWork.mbid))
    .limit(limit);

  let requests = 0;
  let works = 0;
  let unavailable = 0;
  for (const stub of stubs) {
    const { requests: spent } = await ingestWorkTree(source, stub.mbid);
    requests += spent;
    if (spent === 0) continue;

    const [still] = await db
      .select({ mbid: mbWork.mbid })
      .from(mbWork)
      .where(and(eq(mbWork.mbid, stub.mbid), eq(mbWork.detail, 'stub')));
    if (still) {
      await db.update(mbWork).set({ fetchedAt: new Date() }).where(eq(mbWork.mbid, stub.mbid));
      unavailable++;
    } else {
      works++;
    }
  }
  return { works, requests, unavailable };
}

// For works whose stored composer may be an `additional` one (Süßmayr on the Requiem). Resumable:
// works read at or after `since` are skipped.
export async function refreshWorkComposers(
  source: MusicBrainzSource,
  options: { since: Date; limit: number; onProgress?: (line: string) => void },
): Promise<{
  read: number;
  changed: { mbid: string; title: string; from: string | null; to: string | null }[];
}> {
  const since = options.since.getTime();
  const candidates = await db.all<{ mbid: string }>(sql`
    with recursive up(mbid, ancestor, depth) as (
      select mbid, parent_mbid, 1 from mb_work
        where detail = 'full' and composer_mbid is not null and parent_mbid is not null
      union all
      select up.mbid, w.parent_mbid, up.depth + 1 from up
        join mb_work w on w.mbid = up.ancestor
        where w.composer_mbid is null and w.parent_mbid is not null and up.depth < ${MAX_TREE_DEPTH}
    ),
    inherited as (
      select up.mbid, w.composer_mbid from up join mb_work w on w.mbid = up.ancestor
        where w.composer_mbid is not null
    )
    select w.mbid from mb_work w
      left join inherited i on i.mbid = w.mbid
      where w.detail = 'full' and w.composer_mbid is not null and w.fetched_at < ${since}
        and (w.parent_mbid is null or i.composer_mbid is null or i.composer_mbid <> w.composer_mbid)
      order by w.parent_mbid is not null, w.mbid
  `);

  const changed: { mbid: string; title: string; from: string | null; to: string | null }[] = [];
  let read = 0;

  async function reread(mbid: string): Promise<boolean> {
    const [before] = await db
      .select({ composerMbid: mbWork.composerMbid })
      .from(mbWork)
      .where(eq(mbWork.mbid, mbid));
    const work = await readAndCacheWork(source, mbid);
    read++;
    if (read % 50 === 0) options.onProgress?.(`  ${read} read, ${changed.length} changed`);
    const after = work ? (composerOf(work)?.id ?? null) : (before?.composerMbid ?? null);
    if (!work || after === (before?.composerMbid ?? null)) return false;
    changed.push({ mbid, title: work.title, from: before?.composerMbid ?? null, to: after });
    // Reported as it happens, so a run that dies part way still says what it changed.
    options.onProgress?.(
      `changed\t${mbid}\t${work.title}\t${before?.composerMbid ?? 'none'} -> ${after ?? 'none'}`,
    );
    return true;
  }

  const queue = candidates.map((row) => row.mbid);
  options.onProgress?.(`${queue.length} candidate works`);
  while (queue.length > 0 && read < options.limit) {
    const mbid = queue.shift()!;
    if (!(await reread(mbid))) continue;
    // Its parts that repeated the old composer would now disagree with it.
    const parts = await db.all<{ mbid: string }>(sql`
      with recursive down(mbid, depth) as (
        select mbid, 1 from mb_work where parent_mbid = ${mbid}
        union all
        select w.mbid, down.depth + 1 from mb_work w join down on w.parent_mbid = down.mbid
          where down.depth < ${MAX_TREE_DEPTH}
      )
      select distinct w.mbid from mb_work w join down on down.mbid = w.mbid
        where w.detail = 'full' and w.composer_mbid is not null and w.fetched_at < ${since}
    `);
    const queued = new Set(queue);
    queue.unshift(...parts.map((part) => part.mbid).filter((part) => !queued.has(part)));
  }

  return { read, changed };
}

/** The work tree is already cached, so a re-read is one request per release. */
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

/** Composers first: their dates place a work in a period, which the reader shows. */
async function artistsNeedingDetail(limit: number): Promise<string[]> {
  // A composer read before we asked for links is read again for its portrait.
  const composers = await db
    .selectDistinct({ mbid: mbArtist.mbid })
    .from(mbArtist)
    .innerJoin(mbWork, eq(mbWork.composerMbid, mbArtist.mbid))
    .where(isNull(mbArtist.linksReadAt))
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
