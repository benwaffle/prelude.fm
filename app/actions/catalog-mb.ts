'use server';

import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { forChunks, jsonList } from '@/lib/db/chunked';
import { heldWorkLinks } from '@/lib/db/held-work-links';
import { mbArtist, mbWork, mbWorkCatalogue, spotifyArtist } from '@/lib/db/schema';
import { readWorkNeighbourhood, subtreeOf } from '@/lib/db/work-tree-sql';
import { filmScoreInputs } from '@/lib/film-score-inputs';
import { filmScoreReason } from '@/lib/film-scores';
import { parseCatalogueQuery } from '@/lib/catalogue-query';
import {
  shapeHeldCatalogue,
  type CatalogueReference,
  type HeldRelation,
  type ShapedCatalogueWork,
} from '@/lib/musicbrainz-catalogue-shape';
import { indexWorks, workAttributes } from '@/lib/musicbrainz-display-work';
import { readLibraryCards } from '@/lib/musicbrainz-library-cards';
import { recordingRowOf } from '@/lib/musicbrainz-library-view';
import { ancestry } from '@/lib/musicbrainz-work-tree';
import { findProviderTracksForWork } from '@/lib/musicbrainz-work-queries';
import { eraFor, lifespan, portraitOf, shortName, surname } from '@/lib/prelude';
import type {
  CatalogComposer,
  CatalogRecording,
  CatalogWork,
  CatalogWorkHeader,
} from '@/lib/library-types';

export interface WorkSearchHit {
  workId: string;
  /** Null when the MusicBrainz cache does not hold the work. */
  title: string | null;
  nickname: string | null;
  composerId: string;
  composerName: string;
  /** The reference the search matched on, which may not be the primary one. */
  matchedOn: string | null;
  /** Every reference the work carries, so the reader can see what it is called. */
  references: string[];
  recordingCount: number;
}

/**
 * The catalogue, read from MusicBrainz: composers → works → recordings.
 *
 * "We hold" is `heldWorkLinks`: a Spotify track anchored to a MusicBrainz
 * recording of the work, or linked to it by us where MusicBrainz has no
 * link. A work MusicBrainz knows and we cannot play is not in this catalogue
 * — it is a gap the library reports, not a row to browse.
 *
 * The level rule is the library's (`resolveDisplayWork`), so a card's work
 * and a catalogue row are the same work, composer and catalogue number.
 */

/**
 * Everything held, shaped into the works a reader would name.
 *
 * `seedWorkMbids` narrows it to one neighbourhood — one composer, one search
 * result. Without that every click in the catalogue was a scan of every
 * anchor, every work relation and every catalogue reference we hold, which
 * is a great deal of work to answer a question about one composer.
 */
async function heldCatalogue(seedWorkMbids?: string[]): Promise<ShapedCatalogueWork[]> {
  if (seedWorkMbids && seedWorkMbids.length === 0) return [];
  const held = await heldWorkLinks(
    seedWorkMbids ? { works: subtreeOf(jsonList(seedWorkMbids)) } : undefined,
  );
  if (held.length === 0) return [];

  // The related works, their ancestors and one generation of children — the
  // children so the level rule can tell a work with parts from a leaf.
  const [works, filmScoreInputOf] = await Promise.all([
    readWorkNeighbourhood(held.map((link) => link.workMbid)),
    filmScoreInputs(held.map((link) => link.spotifyTrackId)),
  ]);
  const references = await referencesOf(works.map((work) => work.mbid));
  const workByMbid = new Map(works.map((work) => [work.mbid, work]));
  const catalogued = new Set(references.map((reference) => reference.workMbid));
  const relations = withoutFilmScores(held, (row) =>
    filmScoreReason(
      { workMbids: [row.workMbid], ...filmScoreInputOf(row.spotifyTrackId) },
      workByMbid,
      catalogued,
    ),
  );
  if (relations.length === 0) return [];
  return shapeHeldCatalogue(relations, works, references);
}

/**
 * Film scores are not part of the catalogue (see `film-scores`). A holding
 * stays if any track we can play it from is not a film score, which keeps a
 * Chopin nocturne that happens to be issued on a soundtrack album.
 */
function withoutFilmScores(
  held: HeldRelation[],
  filmScoreOf: (row: HeldRelation) => string | null,
): HeldRelation[] {
  const kept = new Map<string, HeldRelation>();
  for (const row of held) {
    const key = `${row.recordingMbid ?? `track:${row.spotifyTrackId}`} ${row.workMbid}`;
    if (!kept.has(key) && !filmScoreOf(row)) kept.set(key, row);
  }
  return [...kept.values()];
}

/** Column one: every composer MusicBrainz attributes something we hold to. */
export async function getMusicBrainzCatalogComposers(): Promise<CatalogComposer[]> {
  const shaped = await heldCatalogue();
  const byComposer = new Map<string, { works: number; holdings: Set<string> }>();
  for (const work of shaped) {
    // A work MusicBrainz attributes to nobody has no composer to file it
    // under. It is reachable from the library and from search; it is simply
    // not a row in a list of composers.
    if (!work.composerMbid) continue;
    const entry = byComposer.get(work.composerMbid) ?? { works: 0, holdings: new Set<string>() };
    entry.works += 1;
    for (const holding of work.holdings) entry.holdings.add(holding);
    byComposer.set(work.composerMbid, entry);
  }
  if (byComposer.size === 0) return [];

  const artists = await forChunks(byComposer.keys(), (chunk) =>
    db
      .select({ artist: mbArtist, images: spotifyArtist.images })
      .from(mbArtist)
      .leftJoin(spotifyArtist, eq(spotifyArtist.spotifyId, mbArtist.spotifyArtistId))
      .where(inArray(mbArtist.mbid, chunk)),
  );
  return artists
    .map(({ artist, images }): CatalogComposer => {
      const entry = byComposer.get(artist.mbid)!;
      return {
        id: artist.mbid,
        name: artist.name,
        short: shortName(artist.name),
        sort: artist.sortName ?? surname(artist.name),
        era: eraFor(artist.beginYear),
        born: artist.beginYear,
        died: artist.endYear,
        years: lifespan(artist.beginYear, artist.endYear),
        image: portraitOf(images),
        workCount: entry.works,
        recordingCount: entry.holdings.size,
      };
    })
    .sort((left, right) => left.sort.localeCompare(right.sort, 'en'));
}

/** Column two: the works of one composer that we hold a recording of. */
export async function getMusicBrainzCatalogWorks(composerMbid: string): Promise<CatalogWork[]> {
  const byThisComposer = await db
    .select({ mbid: mbWork.mbid })
    .from(mbWork)
    .where(eq(mbWork.composerMbid, composerMbid));
  const shaped = (await heldCatalogue(byThisComposer.map((work) => work.mbid))).filter(
    (work) => work.composerMbid === composerMbid,
  );
  const childCounts = await partCounts(shaped.map((work) => work.mbid));
  return shaped
    .map(
      (work): CatalogWork => ({
        id: work.mbid,
        title: work.title,
        // A nickname is a MusicBrainz alias, which nothing reads yet.
        nickname: null,
        catalog: work.reference ? `${work.reference.system} ${work.reference.number}` : null,
        // MusicBrainz dates a work through a composition relationship we do
        // not cache. Null, not a guess from the recording's release year.
        year: null,
        genre: work.type,
        movementCount: childCounts.get(work.mbid) ?? 0,
        recordingCount: work.holdings.length,
      }),
    )
    .sort((left, right) => (left.catalog ?? '~').localeCompare(right.catalog ?? '~', 'en'));
}

async function partCounts(workMbids: string[]): Promise<Map<string, number>> {
  if (workMbids.length === 0) return new Map();
  const rows = await db
    .select({ parentMbid: mbWork.parentMbid, count: sql<number>`count(*)` })
    .from(mbWork)
    .where(sql`${mbWork.parentMbid} in (${jsonList(workMbids)})`)
    .groupBy(mbWork.parentMbid);
  return new Map(
    rows.flatMap((row) => (row.parentMbid ? [[row.parentMbid, Number(row.count)] as const] : [])),
  );
}

/**
 * The work heading above column three.
 *
 * Scoped to the one work rather than shaping the whole held catalogue: this
 * runs on every click in the third column, and the global version made each
 * of those a full scan of every anchor we hold.
 */
export async function getMusicBrainzCatalogWorkHeader(
  workMbid: string,
): Promise<CatalogWorkHeader | null> {
  // The work, its ancestors (where its number and composer may be filed)
  // and its parts, in one read.
  const neighbourhood = await readWorkNeighbourhood([workMbid]);
  const byMbid = new Map(neighbourhood.map((node) => [node.mbid, node]));
  const work = byMbid.get(workMbid);
  if (!work) return null;

  const lineage = ancestry(workMbid, byMbid);
  const references = await referencesOf(lineage.map((node) => node.mbid));
  const { references: nearest, composerMbid } = workAttributes(
    lineage,
    indexWorks(neighbourhood, references),
  );
  const [composerRow] = composerMbid
    ? await db
        .select({ name: mbArtist.name })
        .from(mbArtist)
        .where(eq(mbArtist.mbid, composerMbid))
        .limit(1)
    : [];
  return {
    id: work.mbid,
    title: work.title,
    nickname: null,
    catalog: nearest[0] ? `${nearest[0].system} ${nearest[0].number}` : null,
    year: null,
    genre: work.type,
    composerName: composerRow?.name ?? null,
    movementCount: neighbourhood.filter((node) => node.parentMbid === workMbid).length,
  };
}

/**
 * Find works by catalogue reference or by title, in MusicBrainz.
 *
 * A reference matches any of a work's references, not only the one its card
 * shows — a Scarlatti sonata carries Kk. 9 and L 413, and a reader who knows
 * the Longo number should find it. Results are limited to works we can play,
 * because a search result that leads nowhere is not a result.
 */
export async function searchMusicBrainzWorks(
  rawQuery: string,
  limit = 40,
): Promise<WorkSearchHit[]> {
  const parsed = parseCatalogueQuery(rawQuery);
  if (parsed.kind === 'text' && parsed.text.length < 2) return [];

  const matchedWorkMbids =
    parsed.kind === 'reference'
      ? await db
          .select({ workMbid: mbWorkCatalogue.workMbid })
          .from(mbWorkCatalogue)
          .where(
            and(
              eq(mbWorkCatalogue.normalizedSystem, parsed.system),
              eq(mbWorkCatalogue.normalizedNumber, parsed.number),
            ),
          )
      : parsed.kind === 'number'
        ? await db
            .select({ workMbid: mbWorkCatalogue.workMbid })
            .from(mbWorkCatalogue)
            .where(eq(mbWorkCatalogue.normalizedNumber, parsed.number))
        : await db
            .select({ workMbid: mbWork.mbid })
            .from(mbWork)
            .leftJoin(mbArtist, eq(mbArtist.mbid, mbWork.composerMbid))
            .where(
              or(
                like(sql`lower(${mbWork.title})`, `%${parsed.text}%`),
                like(sql`lower(coalesce(${mbArtist.name}, ''))`, `%${parsed.text}%`),
              ),
            )
            .limit(limit * 8);

  const wanted = new Set(matchedWorkMbids.map((row) => row.workMbid));
  if (wanted.size === 0) return [];

  const shaped = await heldCatalogue([...wanted]);
  // A reference sits on the piece; the query may have matched it there while
  // the work a reader clicks is the same piece. Match either way round.
  const hits = shaped.filter(
    (work) => wanted.has(work.mbid) || (work.reference && wanted.has(work.reference.workMbid)),
  );
  const [references, composerNames] = await Promise.all([
    referencesOf(hits.flatMap((work) => (work.reference ? [work.reference.workMbid] : []))),
    composerNamesFor(hits),
  ]);
  const referencesByWork = new Map<string, string[]>();
  for (const reference of references) {
    referencesByWork.set(reference.workMbid, [
      ...(referencesByWork.get(reference.workMbid) ?? []),
      `${reference.system} ${reference.number}`,
    ]);
  }

  return hits.slice(0, limit).map(
    (work): WorkSearchHit => ({
      workId: work.mbid,
      title: work.title,
      nickname: null,
      composerId: work.composerMbid ?? '',
      composerName: work.composerMbid ? (composerNames.get(work.composerMbid) ?? '') : '',
      matchedOn: work.reference ? `${work.reference.system} ${work.reference.number}` : null,
      references: work.reference ? (referencesByWork.get(work.reference.workMbid) ?? []) : [],
      recordingCount: work.holdings.length,
    }),
  );
}

/** Every catalogue reference these works carry. */
async function referencesOf(workMbids: string[]): Promise<CatalogueReference[]> {
  if (workMbids.length === 0) return [];
  return db
    .select({
      workMbid: mbWorkCatalogue.workMbid,
      system: mbWorkCatalogue.system,
      number: mbWorkCatalogue.number,
      normalizedSystem: mbWorkCatalogue.normalizedSystem,
      normalizedNumber: mbWorkCatalogue.normalizedNumber,
    })
    .from(mbWorkCatalogue)
    .where(sql`${mbWorkCatalogue.workMbid} in (${jsonList(workMbids)})`);
}

async function composerNamesFor(works: ShapedCatalogueWork[]): Promise<Map<string, string>> {
  const mbids = works.flatMap((work) => (work.composerMbid ? [work.composerMbid] : []));
  if (mbids.length === 0) return new Map();
  const rows = await db
    .select({ mbid: mbArtist.mbid, name: mbArtist.name })
    .from(mbArtist)
    .where(sql`${mbArtist.mbid} in (${jsonList(mbids)})`);
  return new Map(rows.map((row) => [row.mbid, row.name]));
}

/** Column three: every issue of one work we can play, fullest first. */
export async function getMusicBrainzCatalogRecordings(
  workMbid: string,
  likedTrackIds: string[] = [],
): Promise<CatalogRecording[]> {
  const liked = new Set(likedTrackIds);
  const trackIds = await findProviderTracksForWork(workMbid);
  if (trackIds.length === 0) return [];
  const { works } = await readLibraryCards(trackIds, liked);
  return (
    works
      .filter((card) => card.workId === workMbid)
      .map((card) => {
        const { durationMs, ...row } = recordingRowOf(card);
        const played = card.movements.filter((movement) => !movement.missing);
        const recording: CatalogRecording = {
          ...row,
          liked: played.filter((movement) => movement.liked).length,
        };
        return { recording, durationMs: durationMs ?? 0 };
      })
      // Compare milliseconds, not the formatted "m:ss" text: as strings "9:59"
      // sorts above "10:00".
      .sort(
        (left, right) =>
          right.recording.liked - left.recording.liked || right.durationMs - left.durationMs,
      )
      .map(({ recording }) => recording)
  );
}
