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
} from './db/schema';
import { bumpCacheLookup, recordMusicBrainzRequest } from './musicbrainz-cache-metrics';
import { normalizeIsrc } from './isrc';
import { cataloguesOf, composerOf, parentPartOf, yearOf } from './musicbrainz';
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

/** A transaction or the root client; the cache writes through either. */
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Collapse rows that would collide on their key before they reach SQLite. */
function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

/* ------------------------------------------------------------- lookup --- */

/** Whether a release MBID is already present in the local cache. */
export async function releaseIsCached(releaseMbid: string): Promise<boolean> {
  const [row] = await db
    .select({ mbid: mbRelease.mbid })
    .from(mbRelease)
    .where(eq(mbRelease.mbid, releaseMbid))
    .limit(1);
  return Boolean(row);
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
  const references = cataloguesOf(work).flatMap((catalogue) => {
    const split = splitCatalogueReference(catalogue.system, catalogue.number);
    return split ? [{ seriesMbid: catalogue.seriesId, ...split }] : [];
  });

  // One batch, so the catalogue references are never left deleted and not
  // yet put back.
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
      recording.isrcs.map((isrc) => ({ isrc: normalizeIsrc(isrc), recordingMbid: recording.id })),
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

    // One statement per batch rather than one per recording: a box set is a
    // few hundred rows, and a round trip each made caching one a minute's work.
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

  for (const batch of chunksOf([...named], INSERT_CHUNK)) {
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

/**
 * Read one work and cache it, returning what MusicBrainz said so a caller
 * that also needs its parts does not have to ask twice. Null when
 * MusicBrainz has no such work.
 */
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
 *
 * A stub MusicBrainz will not hand back as itself — removed, or merged into
 * another work, so the answer carries a different MBID — stays a stub: we
 * still have not read that work, and the gap should keep showing. Its
 * `fetched_at` moves to now so the next slice starts with stubs nobody has
 * tried yet; without that, a slice's worth of such works at the head of the
 * table would be asked for again on every pass and the rest never reached.
 */
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

/**
 * Re-read works whose stored composer may be a work's second composer.
 *
 * Until `composerOf` learned to prefer the main composer, a work crediting
 * several (Mozart's Requiem names Süßmayr as an additional composer) was
 * filed under whichever MusicBrainz listed first. Nothing in the cache says
 * how many composers a work has, so the candidates are re-read: every
 * top-level work with a composer, and every part whose composer is not the
 * one it would inherit. Parts that simply repeat their parent's composer are
 * re-read only when that parent's composer changed.
 *
 * Resumable: works read at or after `since` are skipped, so a rerun given the
 * first run's start time picks up where it stopped.
 */
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
