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
  mbRecording,
  mbRecordingCredit,
  mbRecordingIsrc,
  mbRecordingWork,
  mbRelease,
  mbReleaseTrack,
  mbWork,
  mbWorkCatalogue,
} from './db/schema';
import { cataloguesOf, composerOf, parentPartOf, yearOf } from './musicbrainz';
import { splitCatalogueReference } from './musicbrainz-catalogue';
import type { MbArtist, MbRelease, MbWork, MusicBrainzSource } from './musicbrainz-source';

/** libSQL takes large statements, but not unbounded ones. */
const INSERT_CHUNK = 200;

function chunk<T>(items: T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------ entities --- */

export async function cacheArtist(artist: MbArtist) {
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
async function cacheWorkStubs(works: { id: string; title: string; type?: string | null }[]) {
  const unique = new Map(works.map((work) => [work.id, work]));
  for (const batch of chunk([...unique.values()])) {
    await db
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
export async function cacheWork(work: MbWork): Promise<{ parentMbid: string | null }> {
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

export async function cacheRelease(release: MbRelease): Promise<CachedRelease> {
  const releaseRow = {
    mbid: release.id,
    title: release.title,
    barcode: release.barcode,
    date: release.date,
    country: release.country,
    fetchedAt: new Date(),
  };
  await db
    .insert(mbRelease)
    .values(releaseRow)
    .onConflictDoUpdate({ target: mbRelease.mbid, set: releaseRow });

  const recordings = new Map(release.tracks.map((track) => [track.recording.id, track.recording]));
  const recordingIds = [...recordings.keys()];

  // Rewrite rather than merge: a tracklist that changed upstream should not
  // leave our copy holding both readings at once.
  await db.delete(mbReleaseTrack).where(eq(mbReleaseTrack.releaseMbid, release.id));
  for (const batch of chunk(release.tracks)) {
    await db.insert(mbReleaseTrack).values(
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

  for (const batch of chunk([...recordings.values()])) {
    for (const recording of batch) {
      const row = {
        mbid: recording.id,
        title: recording.title,
        length: recording.length,
        detail: 'full' as const,
        fetchedAt: new Date(),
      };
      await db
        .insert(mbRecording)
        .values(row)
        .onConflictDoUpdate({ target: mbRecording.mbid, set: row });
    }
  }

  if (recordingIds.length > 0) {
    for (const batch of chunk(recordingIds)) {
      await db.delete(mbRecordingWork).where(inArray(mbRecordingWork.recordingMbid, batch));
      await db.delete(mbRecordingCredit).where(inArray(mbRecordingCredit.recordingMbid, batch));
      await db.delete(mbRecordingIsrc).where(inArray(mbRecordingIsrc.recordingMbid, batch));
    }
  }

  const workLinks = [...recordings.values()].flatMap((recording) =>
    recording.works.map((work) => ({ recordingMbid: recording.id, workMbid: work.id })),
  );
  for (const batch of chunk(workLinks)) {
    await db.insert(mbRecordingWork).values(batch).onConflictDoNothing();
  }

  const isrcs = [...recordings.values()].flatMap((recording) =>
    recording.isrcs.map((isrc) => ({ isrc, recordingMbid: recording.id })),
  );
  for (const batch of chunk(isrcs)) {
    await db.insert(mbRecordingIsrc).values(batch).onConflictDoNothing();
  }

  const credits = [...recordings.values()].flatMap((recording) =>
    recording.credits.map((credit) => ({
      recordingMbid: recording.id,
      artistMbid: credit.artistId,
      role: credit.role,
      instrument: credit.instrument ?? '',
    })),
  );
  for (const batch of chunk(credits)) {
    await db.insert(mbRecordingCredit).values(batch).onConflictDoNothing();
  }

  const namedArtists = new Map<string, { name: string; creditedName: string | null }>();
  for (const recording of recordings.values()) {
    for (const credit of recording.credits) {
      if (!namedArtists.has(credit.artistId)) {
        namedArtists.set(credit.artistId, { name: credit.name, creditedName: null });
      }
    }
    for (const credited of recording.artistCredit) {
      const existing = namedArtists.get(credited.artistId);
      if (existing) existing.creditedName ??= credited.name;
      else
        namedArtists.set(credited.artistId, { name: credited.name, creditedName: credited.name });
    }
  }
  for (const batch of chunk([...namedArtists])) {
    for (const [mbid, artist] of batch) {
      await db
        .insert(mbArtist)
        .values({ mbid, name: artist.name, creditedName: artist.creditedName })
        .onConflictDoUpdate({
          target: mbArtist.mbid,
          // Only fills a gap: a name we already learned is not replaced by a
          // later release crediting the same artist differently.
          set: { creditedName: sql`coalesce(${mbArtist.creditedName}, excluded.credited_name)` },
        });
    }
  }

  const works = [...recordings.values()].flatMap((recording) => recording.works);
  await cacheWorkStubs(works);

  return {
    releaseMbid: release.id,
    tracks: release.tracks.length,
    recordings: recordingIds.length,
    credits: credits.length,
    isrcs: isrcs.length,
    workMbids: [...new Set(works.map((work) => work.id))],
  };
}

/* -------------------------------------------------------------- ingest --- */

/** Works we know the name of but have never read. */
export async function worksNeedingDetail(mbids: string[]): Promise<string[]> {
  if (mbids.length === 0) return [];
  const known = new Set<string>();
  for (const batch of chunk(mbids)) {
    const rows = await db
      .select({ mbid: mbWork.mbid })
      .from(mbWork)
      .where(and(inArray(mbWork.mbid, batch), eq(mbWork.detail, 'full')));
    for (const row of rows) known.add(row.mbid);
  }
  return mbids.filter((mbid) => !known.has(mbid));
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
    const detail = await source.recordingDetail(stub.mbid);
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
export async function artistsNeedingDetail(limit: number): Promise<string[]> {
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
    const artist = await source.artist(mbid);
    requests++;
    if (!artist) continue;
    await cacheArtist(artist);
    artists++;
  }

  return { artists, requests };
}
