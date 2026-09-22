'use server';

import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  mbArtist,
  mbRecordingWork,
  mbWork,
  mbWorkCatalogue,
  trackRecording,
} from '@/lib/db/schema';
import { parseCatalogueQuery } from '@/lib/catalogue-query';
import { shapeHeldCatalogue, type ShapedCatalogueWork } from '@/lib/musicbrainz-catalogue-shape';
import { eraFor, formatDuration, lifespan, shortName, surname } from '@/lib/prelude';
import { findProviderTracksForWork, loadMusicBrainzLibraryFacts } from './library-musicbrainz';
import { projectMusicBrainzLibrary } from '@/lib/musicbrainz-library';
import { musicBrainzLibraryView } from '@/lib/musicbrainz-library-view';
import type { CatalogComposer, CatalogRecording, CatalogWork, CatalogWorkHeader } from './library';
import type { WorkSearchHit } from './catalogue-search';

/**
 * The catalogue, read from MusicBrainz: composers → works → recordings.
 *
 * "We hold" means a Spotify track is anchored to a MusicBrainz recording of
 * the work. A work MusicBrainz knows and we cannot play is not in this
 * catalogue — it is a gap the library reports, not a row to browse.
 *
 * The level rule is the library's, so a card's work and a catalogue row are
 * the same work and the same identity.
 */

/** Everything anchored, shaped into the works a reader would name. */
async function heldCatalogue(): Promise<ShapedCatalogueWork[]> {
  const anchored = await db
    .selectDistinct({ recordingMbid: trackRecording.recordingMbid })
    .from(trackRecording);
  if (anchored.length === 0) return [];

  const relations = await db
    .select({
      recordingMbid: mbRecordingWork.recordingMbid,
      workMbid: mbRecordingWork.workMbid,
    })
    .from(mbRecordingWork)
    .innerJoin(trackRecording, eq(trackRecording.recordingMbid, mbRecordingWork.recordingMbid));

  // The related works, their ancestors and one generation of children — the
  // children so the level rule can tell a work with parts from a leaf.
  const works = await readWorkNeighbourhood(relations.map((relation) => relation.workMbid));
  const references = await db
    .select({
      workMbid: mbWorkCatalogue.workMbid,
      system: mbWorkCatalogue.system,
      number: mbWorkCatalogue.number,
    })
    .from(mbWorkCatalogue);
  return shapeHeldCatalogue(relations, works, references);
}

async function readWorkNeighbourhood(seedMbids: string[]) {
  const byMbid = new Map<string, Awaited<ReturnType<typeof selectWorks>>[number]>();
  let frontier = Array.from(new Set(seedMbids));
  for (let depth = 0; depth < 16 && frontier.length > 0; depth++) {
    for (const row of await selectWorks(frontier)) byMbid.set(row.mbid, row);
    frontier = Array.from(byMbid.values())
      .map((row) => row.parentMbid)
      .filter((mbid): mbid is string => mbid !== null && !byMbid.has(mbid));
  }
  const children = await db
    .select({
      mbid: mbWork.mbid,
      title: mbWork.title,
      type: mbWork.type,
      parentMbid: mbWork.parentMbid,
      orderingKey: mbWork.orderingKey,
      composerMbid: mbWork.composerMbid,
    })
    .from(mbWork)
    .where(inArray(mbWork.parentMbid, Array.from(byMbid.keys()).slice(0, 400)));
  for (const row of children) if (!byMbid.has(row.mbid)) byMbid.set(row.mbid, row);
  return Array.from(byMbid.values());
}

function selectWorks(mbids: string[]) {
  return db
    .select({
      mbid: mbWork.mbid,
      title: mbWork.title,
      type: mbWork.type,
      parentMbid: mbWork.parentMbid,
      orderingKey: mbWork.orderingKey,
      composerMbid: mbWork.composerMbid,
    })
    .from(mbWork)
    .where(inArray(mbWork.mbid, mbids.slice(0, 400)));
}

/** Column one: every composer MusicBrainz attributes something we hold to. */
export async function getMusicBrainzCatalogComposers(): Promise<CatalogComposer[]> {
  const shaped = await heldCatalogue();
  const byComposer = new Map<string, { works: number; recordings: Set<string> }>();
  for (const work of shaped) {
    // A work MusicBrainz attributes to nobody has no composer to file it
    // under. It is reachable from the library and from search; it is simply
    // not a row in a list of composers.
    if (!work.composerMbid) continue;
    const entry = byComposer.get(work.composerMbid) ?? { works: 0, recordings: new Set<string>() };
    entry.works += 1;
    for (const recordingMbid of work.recordingMbids) entry.recordings.add(recordingMbid);
    byComposer.set(work.composerMbid, entry);
  }
  if (byComposer.size === 0) return [];

  const artists = await db
    .select()
    .from(mbArtist)
    .where(inArray(mbArtist.mbid, Array.from(byComposer.keys()).slice(0, 400)));
  return artists
    .map((artist): CatalogComposer => {
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
        // MusicBrainz has no portrait, and Spotify's artist image is not the
        // composer's unless something has matched the two.
        image: null,
        workCount: entry.works,
        recordingCount: entry.recordings.size,
      };
    })
    .sort((left, right) => left.sort.localeCompare(right.sort, 'en'));
}

/** Column two: the works of one composer that we hold a recording of. */
export async function getMusicBrainzCatalogWorks(composerMbid: string): Promise<CatalogWork[]> {
  const shaped = await heldCatalogue();
  const childCounts = await partCounts(
    shaped.filter((work) => work.composerMbid === composerMbid).map((work) => work.mbid),
  );
  return shaped
    .filter((work) => work.composerMbid === composerMbid)
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
        recordingCount: work.recordingMbids.length,
      }),
    )
    .sort((left, right) => (left.catalog ?? '~').localeCompare(right.catalog ?? '~', 'en'));
}

async function partCounts(workMbids: string[]): Promise<Map<string, number>> {
  if (workMbids.length === 0) return new Map();
  const rows = await db
    .select({ parentMbid: mbWork.parentMbid, count: sql<number>`count(*)` })
    .from(mbWork)
    .where(inArray(mbWork.parentMbid, workMbids.slice(0, 400)))
    .groupBy(mbWork.parentMbid);
  return new Map(
    rows.flatMap((row) => (row.parentMbid ? [[row.parentMbid, Number(row.count)] as const] : [])),
  );
}

/** The work heading above column three. */
export async function getMusicBrainzCatalogWorkHeader(
  workMbid: string,
): Promise<CatalogWorkHeader | null> {
  const shaped = (await heldCatalogue()).find((work) => work.mbid === workMbid);
  if (!shaped) return null;
  const [composerRow] = shaped.composerMbid
    ? await db.select().from(mbArtist).where(eq(mbArtist.mbid, shaped.composerMbid)).limit(1)
    : [];
  const counts = await partCounts([workMbid]);
  return {
    id: shaped.mbid,
    title: shaped.title,
    nickname: null,
    catalog: shaped.reference ? `${shaped.reference.system} ${shaped.reference.number}` : null,
    year: null,
    genre: shaped.type,
    composerName: composerRow?.name ?? null,
    movementCount: counts.get(workMbid) ?? 0,
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

  const shaped = await heldCatalogue();
  const references = await db
    .select({
      workMbid: mbWorkCatalogue.workMbid,
      system: mbWorkCatalogue.system,
      number: mbWorkCatalogue.number,
    })
    .from(mbWorkCatalogue);
  const referencesByWork = new Map<string, string[]>();
  for (const reference of references) {
    referencesByWork.set(reference.workMbid, [
      ...(referencesByWork.get(reference.workMbid) ?? []),
      `${reference.system} ${reference.number}`,
    ]);
  }

  // A reference sits on the piece; the query may have matched it there while
  // the work a reader clicks is the same piece. Match either way round.
  const hits = shaped.filter(
    (work) => wanted.has(work.mbid) || (work.reference && wanted.has(work.reference.workMbid)),
  );
  const composerNames = await composerNamesFor(hits);

  return hits.slice(0, limit).map(
    (work): WorkSearchHit => ({
      workId: work.mbid,
      title: work.title,
      nickname: null,
      composerId: work.composerMbid ?? '',
      composerName: work.composerMbid ? (composerNames.get(work.composerMbid) ?? '') : '',
      matchedOn: work.reference ? `${work.reference.system} ${work.reference.number}` : null,
      references: work.reference ? (referencesByWork.get(work.reference.workMbid) ?? []) : [],
      recordingCount: work.recordingMbids.length,
    }),
  );
}

async function composerNamesFor(works: ShapedCatalogueWork[]): Promise<Map<string, string>> {
  const mbids = Array.from(
    new Set(works.map((work) => work.composerMbid).filter((mbid): mbid is string => !!mbid)),
  );
  if (mbids.length === 0) return new Map();
  const rows = await db
    .select({ mbid: mbArtist.mbid, name: mbArtist.name })
    .from(mbArtist)
    .where(inArray(mbArtist.mbid, mbids.slice(0, 400)));
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
  const { works } = musicBrainzLibraryView(
    projectMusicBrainzLibrary(await loadMusicBrainzLibraryFacts(trackIds)),
    liked,
  );
  return works
    .filter((card) => card.workId === workMbid)
    .map((card): CatalogRecording => {
      const played = card.movements.filter((movement) => !movement.missing);
      const durationMs = played.reduce((sum, movement) => sum + (movement.durationMs ?? 0), 0);
      return {
        id: card.recordingId ?? card.id,
        album: card.album,
        albumId: card.albumId ?? card.id,
        cover: card.cover,
        year: card.year,
        performer: card.performer,
        ensemble: card.ensemble,
        duration: played.length === 0 ? null : formatDuration(durationMs),
        // Spotify popularity is a track's, and nothing has aggregated it per
        // MusicBrainz recording. The screen already says unranked.
        popularity: null,
        tint: card.tint,
        liked: played.filter((movement) => movement.liked).length,
        firstTrackUri: played[0]?.uri ?? null,
        unmatched: false,
      };
    })
    .sort(
      (left, right) =>
        right.liked - left.liked || (right.duration ?? '').localeCompare(left.duration ?? ''),
    );
}
