/**
 * Phase 1 MusicBrainz backfill.
 *
 * Attaches MusicBrainz identity to entities we already hold and records what
 * MusicBrainz asserts about them, without changing anything the app reads.
 * Every step is resumable: the database is the progress record, so a step
 * skips rows it has already resolved and can be re-run after an interruption.
 *
 *   pnpm mb:backfill isrcs       Spotify ISRCs -> spotify_track.isrc
 *   pnpm mb:backfill recordings  ISRC -> spotify_track.mb_recording_id
 *   pnpm mb:backfill works       recording -> work/part MBIDs, catalogues, facts
 *   pnpm mb:backfill composers   work composer rels -> composer MBIDs + dates
 *   pnpm mb:backfill report      what has landed so far
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  composer,
  musicbrainzFact,
  spotifyAlbum,
  spotifyTrack,
  trackWorkPartV2,
  work,
  workCatalogV2,
  workPartV2,
} from '@/lib/db/schema';
import {
  cataloguesOf,
  composerOf,
  findRecordingsByIsrcs,
  findReleasesByBarcode,
  getArtist,
  getRecordingWorks,
  getWork,
  parentWorkOf,
  resolveWorkLevel,
  stripParentPrefix,
  type MatchedPart,
  yearOf,
} from '@/lib/musicbrainz';
import { getSpotifyAlbumsByIds, getSpotifyTracksByIds } from '@/lib/spotify-app-client';
import { normalizeCatalogNumber, normalizeCatalogSystem } from '@/lib/classical-normalization';
import { titlesAreCompatible } from '@/lib/metadata-matching';
import { composerMatchIsCredible, workTitleFromMusicBrainz } from '@/lib/musicbrainz-promotion';

const BATCH = 50;
/**
 * The ISRC search packs many terms into one Lucene query. Long queries make the
 * search server answer 503 under load far more often than a plain lookup does,
 * so this batch stays well below the lookup batch size.
 */
const ISRC_SEARCH_BATCH = 20;

function log(...parts: unknown[]) {
  console.log(...parts);
}

async function recordFact(
  entityType: 'composer' | 'work' | 'work_part',
  entityId: number,
  field: string,
  value: string,
  musicbrainzId: string,
) {
  await db
    .insert(musicbrainzFact)
    .values({ entityType, entityId, field, value, musicbrainzId })
    .onConflictDoUpdate({
      target: [musicbrainzFact.entityType, musicbrainzFact.entityId, musicbrainzFact.field],
      set: { value, musicbrainzId, fetchedAt: new Date() },
    });
}

/* ------------------------------------------------------------- 1. isrcs --- */

async function backfillIsrcs() {
  const rows = await db
    .select({ id: spotifyTrack.spotifyId })
    .from(spotifyTrack)
    .where(isNull(spotifyTrack.isrc));
  log(`[isrcs] ${rows.length} tracks without an ISRC`);
  let written = 0;
  let missing = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const ids = rows.slice(i, i + BATCH).map((r) => r.id);
    const tracks = await getSpotifyTracksByIds(ids);
    for (const track of tracks) {
      const isrc = track.external_ids?.isrc;
      if (!isrc) {
        missing++;
        continue;
      }
      await db.update(spotifyTrack).set({ isrc }).where(eq(spotifyTrack.spotifyId, track.id));
      written++;
    }
    if (i % 1000 === 0) log(`  ${i}/${rows.length}`);
  }
  log(`[isrcs] wrote ${written}; ${missing} tracks have no ISRC on Spotify`);
}

/* -------------------------------------------------------- 2. recordings --- */

async function backfillRecordings() {
  const rows = await db
    .select({ id: spotifyTrack.spotifyId, isrc: spotifyTrack.isrc })
    .from(spotifyTrack)
    .where(and(isNotNull(spotifyTrack.isrc), isNull(spotifyTrack.mbRecordingId)));
  log(`[recordings] ${rows.length} tracks with an ISRC but no MusicBrainz recording`);

  // One ISRC can appear on several of our tracks; ask MusicBrainz once per ISRC.
  const byIsrc = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.isrc) continue;
    const list = byIsrc.get(row.isrc) ?? [];
    list.push(row.id);
    byIsrc.set(row.isrc, list);
  }
  const isrcs = [...byIsrc.keys()];
  log(
    `[recordings] ${isrcs.length} distinct ISRCs to look up (${Math.ceil(isrcs.length / BATCH)} requests)`,
  );

  let resolved = 0;
  let failedBatches = 0;
  for (let i = 0; i < isrcs.length; i += ISRC_SEARCH_BATCH) {
    const batch = isrcs.slice(i, i + ISRC_SEARCH_BATCH);
    let found: Map<string, string>;
    try {
      found = await findRecordingsByIsrcs(batch);
    } catch (error) {
      // The step is resumable, so a batch MusicBrainz would not serve is left
      // for the next run rather than discarding the progress made so far.
      failedBatches++;
      log(
        `  ! batch at ${i} failed: ${error instanceof Error ? error.message.slice(0, 80) : error}`,
      );
      continue;
    }
    for (const [isrc, recordingId] of found) {
      for (const trackId of byIsrc.get(isrc) ?? []) {
        await db
          .update(spotifyTrack)
          .set({ mbRecordingId: recordingId })
          .where(eq(spotifyTrack.spotifyId, trackId));
        resolved++;
      }
    }
    if ((i / ISRC_SEARCH_BATCH) % 25 === 0)
      log(`  ${i}/${isrcs.length} isrcs, ${resolved} tracks resolved`);
  }
  log(`[recordings] resolved ${resolved} tracks`);
  if (failedBatches) log(`[recordings] ${failedBatches} batches unserved; re-run to retry them`);
}

/* ---------------------------------------------------------- releases --- */

/**
 * Ask MusicBrainz whether it holds each album, by barcode.
 *
 * This is what separates the two reasons an album has nothing anchored: the
 * release is missing from MusicBrainz entirely, or it is there and simply has
 * no ISRCs registered. The first needs the release adding, the second needs
 * ISRCs submitting, and they are very different jobs.
 */
async function backfillReleases() {
  const rows = await db
    .select({
      id: spotifyAlbum.spotifyId,
      upc: spotifyAlbum.upc,
      checked: spotifyAlbum.mbCheckedAt,
    })
    .from(spotifyAlbum);

  const needUpc = rows.filter((row) => !row.upc).map((row) => row.id);
  if (needUpc.length) {
    log(`[releases] fetching barcodes for ${needUpc.length} albums`);
    for (let i = 0; i < needUpc.length; i += 20) {
      const batch = needUpc.slice(i, i + 20);
      const albums = await getSpotifyAlbumsByIds(batch);
      for (const album of albums) {
        const upc = album.external_ids?.upc ?? null;
        if (upc) {
          await db.update(spotifyAlbum).set({ upc }).where(eq(spotifyAlbum.spotifyId, album.id));
        }
      }
    }
  }

  const pending = await db
    .select({ id: spotifyAlbum.spotifyId, upc: spotifyAlbum.upc })
    .from(spotifyAlbum)
    .where(or(isNull(spotifyAlbum.mbCheckedAt), isNull(spotifyAlbum.mbReleaseCandidates)));
  log(`[releases] asking MusicBrainz about ${pending.length} albums`);

  let found = 0;
  let absent = 0;
  let ambiguous = 0;
  let done = 0;
  for (const album of pending) {
    if (!album.upc) {
      await db
        .update(spotifyAlbum)
        .set({ mbCheckedAt: new Date() })
        .where(eq(spotifyAlbum.spotifyId, album.id));
      continue;
    }
    let releases;
    try {
      releases = await findReleasesByBarcode(album.upc);
    } catch (error) {
      log(`  ! ${album.upc}: ${error instanceof Error ? error.message.slice(0, 60) : error}`);
      continue;
    }
    // A barcode shared by several releases identifies none of them, and
    // guessing would attach this album to the wrong one.
    const releaseId = releases.length === 1 ? releases[0] : null;
    if (releases.length === 1) found++;
    else if (releases.length === 0) absent++;
    else ambiguous++;
    await db
      .update(spotifyAlbum)
      .set({
        mbReleaseId: releaseId,
        mbReleaseCandidates: releases.length,
        mbCheckedAt: new Date(),
      })
      .where(eq(spotifyAlbum.spotifyId, album.id));
    if (++done % 50 === 0) log(`  ${done}/${pending.length}`);
  }
  log(`[releases] ${found} matched, ${absent} not in MusicBrainz, ${ambiguous} ambiguous barcodes`);
}

/* ------------------------------------------------------------- 3. works --- */

type Vote = Map<number, Map<string, number>>;
function vote(map: Vote, key: number, value: string) {
  const inner = map.get(key) ?? new Map<string, number>();
  inner.set(value, (inner.get(value) ?? 0) + 1);
  map.set(key, inner);
}
/** The single clear winner, or null when the evidence is split. */
function winner(counts: Map<string, number> | undefined): string | null {
  if (!counts) return null;
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ordered.length === 0) return null;
  if (ordered.length > 1 && ordered[0][1] === ordered[1][1]) return null;
  return ordered[0][0];
}

async function backfillWorks() {
  // Split into phases so that every MusicBrainz response is persisted as soon
  // as it arrives. This step makes thousands of requests at one per second; a
  // failure an hour in must not discard the hour, so the aggregation phases
  // read back from the database rather than from memory.
  await identifyParts();
  await fetchLeafWorks();
  await linkWorks();
  await fetchParentWorks();
  await voteComposers();
}

/** Phase A — ask which MusicBrainz work each of our parts performs. */
async function identifyParts() {
  const rows = await db
    .select({
      partId: workPartV2.id,
      partMbid: workPartV2.musicbrainzId,
      recordingId: spotifyTrack.mbRecordingId,
    })
    .from(spotifyTrack)
    .innerJoin(trackWorkPartV2, eq(trackWorkPartV2.spotifyTrackId, spotifyTrack.spotifyId))
    .innerJoin(workPartV2, eq(workPartV2.id, trackWorkPartV2.workPartId))
    .where(isNotNull(spotifyTrack.mbRecordingId));

  // One resolved recording is enough to identify a part.
  const pending = new Map<number, string>();
  for (const row of rows) {
    if (row.partMbid || !row.recordingId) continue;
    if (!pending.has(row.partId)) pending.set(row.partId, row.recordingId);
  }
  log(`[works/A] ${rows.length} linked tracks; ${pending.size} parts to identify`);

  let identified = 0;
  let ambiguous = 0;
  let asked = 0;
  for (const [partId, recordingId] of pending) {
    let works;
    try {
      works = await getRecordingWorks(recordingId);
    } catch (error) {
      log(
        `  ! recording ${recordingId}: ${error instanceof Error ? error.message.slice(0, 70) : error}`,
      );
      continue;
    }
    asked++;
    // A recording of two works in one track cannot identify a single part.
    if (works.length === 1) {
      await db
        .update(workPartV2)
        .set({ musicbrainzId: works[0].id })
        .where(eq(workPartV2.id, partId));
      identified++;
    } else if (works.length > 1) {
      ambiguous++;
    }
    if (asked % 100 === 0) log(`  asked ${asked}/${pending.size}, identified ${identified}`);
  }
  log(`[works/A] identified ${identified} parts (${ambiguous} recordings covered several works)`);
}

/** Phase B — read each distinct leaf work once for its title and its parent. */
async function fetchLeafWorks() {
  const parts = await db
    .select({ id: workPartV2.id, mbid: workPartV2.musicbrainzId })
    .from(workPartV2)
    .where(isNotNull(workPartV2.musicbrainzId));
  const done = new Set(
    (
      await db
        .select({ entityId: musicbrainzFact.entityId })
        .from(musicbrainzFact)
        .where(
          and(
            eq(musicbrainzFact.entityType, 'work_part'),
            eq(musicbrainzFact.field, 'mb_parent_work'),
          ),
        )
    ).map((r) => r.entityId),
  );
  const byLeaf = new Map<string, number[]>();
  for (const part of parts) {
    if (!part.mbid || done.has(part.id)) continue;
    const list = byLeaf.get(part.mbid) ?? [];
    list.push(part.id);
    byLeaf.set(part.mbid, list);
  }
  log(`[works/B] ${byLeaf.size} distinct works to read for ${parts.length - done.size} parts`);

  let fetched = 0;
  for (const [leafId, partIds] of byLeaf) {
    let mbWork;
    try {
      mbWork = await getWork(leafId);
    } catch (error) {
      log(`  ! work ${leafId}: ${error instanceof Error ? error.message.slice(0, 70) : error}`);
      continue;
    }
    if (!mbWork) continue;
    const parent = parentWorkOf(mbWork);
    // A single-movement work has no parent and stands as its own work.
    const target = parent ?? { id: mbWork.id, title: mbWork.title };
    const title = stripParentPrefix(mbWork.title, parent ? parent.title : null);
    for (const partId of partIds) {
      await recordFact('work_part', partId, 'mb_parent_work', target.id, leafId);
      if (title) await recordFact('work_part', partId, 'part_title', title, leafId);
    }
    if (++fetched % 100 === 0) log(`  read ${fetched}/${byLeaf.size}`);
  }
  log(`[works/B] read ${fetched} works`);
}

/** Phase C — decide our work's MusicBrainz identity from its parts. Database only. */
async function linkWorks() {
  const rows = await db
    .select({
      workId: workPartV2.workId,
      workTitle: work.title,
      leafId: workPartV2.musicbrainzId,
      parentId: musicbrainzFact.value,
      partTitle: sql<string>`(
        select value from musicbrainz_fact t
        where t.entity_type = 'work_part' and t.entity_id = ${workPartV2.id}
          and t.field = 'part_title')`,
    })
    .from(workPartV2)
    .innerJoin(work, eq(work.id, workPartV2.workId))
    .innerJoin(
      musicbrainzFact,
      and(
        eq(musicbrainzFact.entityType, 'work_part'),
        eq(musicbrainzFact.entityId, workPartV2.id),
        eq(musicbrainzFact.field, 'mb_parent_work'),
      ),
    );

  const byWork = new Map<number, { title: string; parts: MatchedPart[] }>();
  for (const row of rows) {
    if (!row.leafId) continue;
    const entry = byWork.get(row.workId) ?? { title: row.workTitle, parts: [] };
    entry.parts.push({ leafId: row.leafId, parentId: row.parentId, title: row.partTitle ?? '' });
    byWork.set(row.workId, entry);
  }

  // work.musicbrainz_id is unique; two of our works must never claim one MBID.
  const taken = new Set(
    (
      await db.select({ mbid: work.musicbrainzId }).from(work).where(isNotNull(work.musicbrainzId))
    ).map((r) => r.mbid as string),
  );
  let linked = 0;
  let unresolved = 0;
  const claims = new Map<string, number[]>();
  for (const [workId, entry] of byWork) {
    const chosen = resolveWorkLevel(entry.title, entry.parts, titlesAreCompatible);
    if (!chosen) {
      unresolved++;
      continue;
    }
    const list = claims.get(chosen) ?? [];
    list.push(workId);
    claims.set(chosen, list);
  }

  let contested = 0;
  for (const [mbid, workIds] of claims) {
    // Several of our works resolving to one MusicBrainz work means either they
    // are duplicates of each other or the level is wrong. Either way it is not
    // a thing to settle by taking whichever came first.
    if (workIds.length > 1) {
      contested += workIds.length;
      continue;
    }
    if (taken.has(mbid)) continue;
    taken.add(mbid);
    await db.update(work).set({ musicbrainzId: mbid }).where(eq(work.id, workIds[0]));
    linked++;
  }
  log(
    `[works/C] linked ${linked} works (${unresolved} unresolved, ${contested} contested by several of our works)`,
  );
}

/** Phase D — read each matched work for its type, catalogues and composer. */
async function fetchParentWorks() {
  const works = await db
    .select({ id: work.id, mbid: work.musicbrainzId })
    .from(work)
    .where(isNotNull(work.musicbrainzId));
  const done = new Set(
    (
      await db
        .select({ entityId: musicbrainzFact.entityId })
        .from(musicbrainzFact)
        .where(
          and(eq(musicbrainzFact.entityType, 'work'), eq(musicbrainzFact.field, 'mb_work_read_v2')),
        )
    ).map((r) => r.entityId),
  );
  const todo = works.filter((w) => !done.has(w.id));
  log(`[works/D] ${todo.length} works to read (${done.size} already read)`);

  let types = 0;
  let titles = 0;
  let catalogues = 0;
  let composers = 0;
  let read = 0;
  for (const ourWork of todo) {
    let mbWork;
    try {
      mbWork = await getWork(ourWork.mbid as string);
    } catch (error) {
      log(
        `  ! work ${ourWork.mbid}: ${error instanceof Error ? error.message.slice(0, 70) : error}`,
      );
      continue;
    }
    if (!mbWork) continue;
    if (mbWork.type) {
      await recordFact('work', ourWork.id, 'work_type', mbWork.type, mbWork.id);
      types++;
    }
    // MusicBrainz prefixes a work with the collection it sits in, so the
    // parent is needed to take that back off again.
    const parent = parentWorkOf(mbWork);
    const title = workTitleFromMusicBrainz(mbWork.title, parent ? parent.title : null);
    if (title) {
      await recordFact('work', ourWork.id, 'work_title', title, mbWork.id);
      titles++;
    }
    for (const catalogue of cataloguesOf(mbWork)) {
      const inserted = await db
        .insert(workCatalogV2)
        .values({
          workId: ourWork.id,
          system: catalogue.system,
          number: catalogue.number,
          normalizedSystem: normalizeCatalogSystem(catalogue.system),
          normalizedNumber: normalizeCatalogNumber(catalogue.number),
          isPrimary: false,
          source: 'musicbrainz',
        })
        .onConflictDoNothing()
        .returning({ id: workCatalogV2.id });
      if (inserted.length) catalogues++;
    }
    const mbComposer = composerOf(mbWork);
    if (mbComposer) {
      await recordFact('work', ourWork.id, 'mb_composer_artist', mbComposer.id, mbWork.id);
      composers++;
    }
    // Mark last, so an interrupted work is read again rather than half-recorded.
    await recordFact('work', ourWork.id, 'mb_work_read_v2', '1', mbWork.id);
    if (++read % 100 === 0) log(`  read ${read}/${todo.length}`);
  }
  log(
    `[works/D] ${types} types, ${titles} titles, ${catalogues} new catalogue rows, ${composers} composer relations`,
  );
}

/** Phase E — one MusicBrainz artist per composer, or none. Database only. */
async function voteComposers() {
  const rows = await db
    .select({ composerId: work.composerId, artist: musicbrainzFact.value })
    .from(work)
    .innerJoin(
      musicbrainzFact,
      and(
        eq(musicbrainzFact.entityType, 'work'),
        eq(musicbrainzFact.entityId, work.id),
        eq(musicbrainzFact.field, 'mb_composer_artist'),
      ),
    );
  const votes: Vote = new Map();
  for (const row of rows) vote(votes, row.composerId, row.artist);

  let recorded = 0;
  let conflicted = 0;
  for (const [composerId, counts] of votes) {
    // Works by one composer should all name the same MusicBrainz artist. When
    // they do not, one of the matches is wrong and choosing between them would
    // be a guess, so nothing is recorded.
    if (counts.size > 1) {
      conflicted++;
      log(`  ! composer ${composerId} maps to ${counts.size} MusicBrainz artists; left unset`);
      continue;
    }
    const chosen = winner(counts);
    if (!chosen) continue;
    await recordFact('composer', composerId, 'musicbrainz_artist', chosen, chosen);
    recorded++;
  }
  log(`[works/E] ${recorded} composers identified (${conflicted} conflicted, left unset)`);
}

/* --------------------------------------------------------- 4. composers --- */

async function backfillComposers() {
  // Identity comes from the composer relationship on works we matched, not from
  // matching names: a name search cannot tell four Bachs apart. But the
  // relationship can still be confidently wrong — a transcription performs the
  // original composer's work — so each candidate is corroborated before use.
  const candidates = await db
    .select({ entityId: musicbrainzFact.entityId, artistId: musicbrainzFact.value })
    .from(musicbrainzFact)
    .where(
      and(
        eq(musicbrainzFact.entityType, 'composer'),
        eq(musicbrainzFact.field, 'musicbrainz_artist'),
      ),
    );
  log(`[composers] ${candidates.length} candidates from work relationships`);

  const taken = new Set(
    (
      await db
        .select({ mbid: composer.musicbrainzId })
        .from(composer)
        .where(isNotNull(composer.musicbrainzId))
    ).map((r) => r.mbid as string),
  );

  let linked = 0;
  let dates = 0;
  let rejected = 0;
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (seen.has(candidate.entityId)) continue;
    seen.add(candidate.entityId);

    const [ours] = await db
      .select({
        id: composer.id,
        name: composer.name,
        birthYear: composer.birthYear,
        mbid: composer.musicbrainzId,
      })
      .from(composer)
      .where(eq(composer.id, candidate.entityId))
      .limit(1);
    if (!ours) continue;

    const artist = await getArtist(candidate.artistId);
    if (!artist) continue;

    const mbBirth = yearOf(artist['life-span']?.begin);
    if (!composerMatchIsCredible(ours.name, ours.birthYear, artist.name, mbBirth)) {
      rejected++;
      log(
        `  ! ${ours.name} -> "${artist.name}" (b.${mbBirth ?? '?'}) is not the same person; left unset`,
      );
      continue;
    }

    if (!ours.mbid) {
      if (taken.has(candidate.artistId)) continue;
      taken.add(candidate.artistId);
      await db
        .update(composer)
        .set({ musicbrainzId: candidate.artistId })
        .where(eq(composer.id, ours.id));
      linked++;
    }

    const mbDeath = yearOf(artist['life-span']?.end);
    if (mbBirth != null) {
      await recordFact('composer', ours.id, 'birth_year', String(mbBirth), artist.id);
      dates++;
    }
    if (mbDeath != null) {
      await recordFact('composer', ours.id, 'death_year', String(mbDeath), artist.id);
    }
  }
  log(
    `[composers] linked ${linked}, dates for ${dates}, ${rejected} rejected as a different person`,
  );
}

/** Undo composer links so they can be decided again. */
async function resetComposerLinks() {
  await db.update(composer).set({ musicbrainzId: null });
  await db
    .delete(musicbrainzFact)
    .where(
      and(
        eq(musicbrainzFact.entityType, 'composer'),
        inArray(musicbrainzFact.field, ['birth_year', 'death_year']),
      ),
    );
  log('[reset] cleared composer links and imported dates');
}

/* ------------------------------------------------------------- report --- */

async function report() {
  const [row] = await db
    .select({
      tracks: sql<number>`(select count(*) from spotify_track)`,
      withIsrc: sql<number>`(select count(isrc) from spotify_track)`,
      withRecording: sql<number>`(select count(mb_recording_id) from spotify_track)`,
      works: sql<number>`(select count(*) from work)`,
      worksLinked: sql<number>`(select count(musicbrainz_id) from work)`,
      parts: sql<number>`(select count(*) from work_part_v2)`,
      partsLinked: sql<number>`(select count(musicbrainz_id) from work_part_v2)`,
      composers: sql<number>`(select count(*) from composer)`,
      composersLinked: sql<number>`(select count(musicbrainz_id) from composer)`,
      facts: sql<number>`(select count(*) from musicbrainz_fact)`,
      mbCatalogues: sql<number>`(select count(*) from work_catalog_v2 where source = 'musicbrainz')`,
    })
    .from(sql`(select 1)`);
  console.table([
    { metric: 'tracks', value: row.tracks },
    { metric: 'tracks with ISRC', value: row.withIsrc },
    { metric: 'tracks with MB recording', value: row.withRecording },
    { metric: 'works', value: row.works },
    { metric: 'works linked to MB', value: row.worksLinked },
    { metric: 'parts', value: row.parts },
    { metric: 'parts linked to MB', value: row.partsLinked },
    { metric: 'composers', value: row.composers },
    { metric: 'composers linked to MB', value: row.composersLinked },
    { metric: 'musicbrainz_fact rows', value: row.facts },
    { metric: 'MB-sourced catalogue rows', value: row.mbCatalogues },
  ]);
  const byField = await db
    .select({ field: musicbrainzFact.field, n: sql<number>`count(*)` })
    .from(musicbrainzFact)
    .groupBy(musicbrainzFact.field);
  if (byField.length) console.table(byField);
}

/* --------------------------------------------------------------- main --- */

/**
 * Undo the work-level decisions so they can be made again, keeping the
 * part-level lookups that cost thousands of requests to obtain.
 */
async function resetWorkLinks() {
  await db.update(work).set({ musicbrainzId: null });
  await db.delete(workCatalogV2).where(eq(workCatalogV2.source, 'musicbrainz'));
  await db.delete(musicbrainzFact).where(and(eq(musicbrainzFact.entityType, 'work')));
  await db
    .delete(musicbrainzFact)
    .where(
      and(
        eq(musicbrainzFact.entityType, 'composer'),
        eq(musicbrainzFact.field, 'musicbrainz_artist'),
      ),
    );
  await db.update(composer).set({ musicbrainzId: null });
  log('[reset] cleared work links, imported catalogue rows and work/composer facts');
}

const steps: Record<string, () => Promise<void>> = {
  isrcs: backfillIsrcs,
  recordings: backfillRecordings,
  releases: backfillReleases,
  works: backfillWorks,
  'reset-works': resetWorkLinks,
  'reset-composers': resetComposerLinks,
  composers: backfillComposers,
  report,
};

async function main() {
  const name = process.argv[2];
  const step = name ? steps[name] : undefined;
  if (!step) {
    console.error(`usage: pnpm mb:backfill <${Object.keys(steps).join('|')}>`);
    process.exitCode = 1;
    return;
  }
  await step();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
