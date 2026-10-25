import { asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from './db';
import { heldWorkLinks } from './db/held-work-links';
import { catalogComposer, mbArtist, spotifyArtist } from './db/schema';
import { lineageOf, readWorkCatalogue, readWorkNeighbourhood, subtreeOf } from './db/work-tree-sql';
import { filmScoreInputs } from './film-score-inputs';
import { FILM_COMPOSERS, filmScoreReason } from './film-scores';
import type { CatalogComposer, CatalogWork } from './library-types';
import { shapeHeldCatalogue, type HeldRelation } from './musicbrainz-catalogue-shape';
import { indexWorks, resolveDisplayWork } from './musicbrainz-display-work';
import { eraFor, lifespan, portraitOf, shortName, surname } from './prelude';

// A holding stays if any playable track is not a film score (a Chopin nocturne on a soundtrack
// album).
export function withoutFilmScores(
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

export type ComposerCatalogue = {
  works: CatalogWork[];
  /** Works with a playable recording. */
  playable: number;
  /** Distinct recordings (or unanchored tracks) across them. */
  recordings: number;
  /** About how many rows the reads returned, which is what the refresh budgets by. */
  rowsRead: number;
};

// The composer's whole catalogue, playable or not, at the library's level (parts stay under their
// work). One round trip: every read is handed the composer's trees as a subquery. It reads in
// proportion to what we hold of this composer (all of Bach is ~130k recording links once the
// dump is in), never the whole library.
export async function readComposerCatalogue(composerMbid: string): Promise<ComposerCatalogue> {
  const seeds = sql`select mbid from mb_work where composer_mbid = ${composerMbid} union all select id from own_work where composer_mbid = ${composerMbid} and +mb_work_mbid is null`;
  const tree = subtreeOf(sql`select mbid from ${lineageOf(seeds)}`);
  const held = heldWorkLinks({ works: tree });
  const [works, references, recorded, links, filmScoreInputOf] = await Promise.all([
    readWorkNeighbourhood(seeds, db, { wholeTrees: true }),
    readWorkCatalogue(sql`select mbid from ${tree}`),
    // One row per recorded work, not per recording of it.
    db.all<{ workMbid: string }>(
      sql`select tree.mbid as workMbid from ${tree} as tree where exists (select 1 from mb_recording_work rw where rw.work_mbid = tree.mbid)`,
    ),
    held,
    filmScoreInputs(sql`select spotify_track_id from (${held})`),
  ]);
  const index = indexWorks(works, references);
  const catalogued = new Set(references.map((reference) => reference.workMbid));
  const relations = withoutFilmScores(links, (row) =>
    filmScoreReason(
      { workMbids: [row.workMbid], ...filmScoreInputOf(row.spotifyTrackId) },
      index.workById,
      catalogued,
    ),
  );
  const holdings = new Map(
    shapeHeldCatalogue(relations, works, references).map((work) => [work.mbid, work.holdings]),
  );
  const recordedMbids = new Set(recorded.map((row) => row.workMbid));
  const partCounts = new Map<string, number>();
  for (const work of works) {
    if (work.parentMbid)
      partCounts.set(work.parentMbid, (partCounts.get(work.parentMbid) ?? 0) + 1);
  }

  const rows = new Map<string, CatalogWork>();
  const heldHere = new Set<string>();
  for (const node of works) {
    const resolved = resolveDisplayWork(node.mbid, index);
    const work = resolved.display;
    if (!work || resolved.composerMbid !== composerMbid) continue;
    const reference = resolved.references[0];
    for (const holding of holdings.get(work.mbid) ?? []) heldHere.add(holding);
    const row = rows.get(work.mbid) ?? {
      id: work.mbid,
      title: work.title,
      // A nickname is a MusicBrainz alias, which nothing reads yet.
      nickname: null,
      catalog: reference ? `${reference.system} ${reference.number}` : null,
      // MusicBrainz dates a work through a composition relationship we do not cache. Null, not a
      // guess from the release year.
      year: null,
      genre: work.type,
      movementCount: partCounts.get(work.mbid) ?? 0,
      recordingCount: holdings.get(work.mbid)?.length ?? 0,
      availability: holdings.has(work.mbid) ? 'playable' : 'unrecorded',
      inMusicBrainz: work.source === 'musicbrainz',
    };
    if (row.availability === 'unrecorded' && recordedMbids.has(node.mbid)) {
      row.availability = 'unmatched';
    }
    rows.set(work.mbid, row);
  }
  const sorted = [...rows.values()].sort(
    (left, right) =>
      Number(left.catalog === null) - Number(right.catalog === null) ||
      (left.catalog ?? '').localeCompare(right.catalog ?? '', 'en', { numeric: true }) ||
      (left.title ?? '').localeCompare(right.title ?? '', 'en', { numeric: true }),
  );
  return {
    works: sorted,
    playable: sorted.filter((work) => work.availability === 'playable').length,
    recordings: heldHere.size,
    // Film-score inputs read about three rows per held track.
    rowsRead: works.length + references.length + recorded.length + links.length * 4,
  };
}

export async function recordComposerCounts(
  composerMbid: string,
  catalogue: Pick<ComposerCatalogue, 'works' | 'playable' | 'recordings'>,
  countedAt = new Date(),
): Promise<void> {
  const counts = {
    works: catalogue.works.length,
    playableWorks: catalogue.playable,
    recordings: catalogue.recordings,
    countedAt,
  };
  await db
    .insert(catalogComposer)
    .values({ composerMbid, ...counts })
    .onConflictDoUpdate({ target: catalogComposer.composerMbid, set: counts });
}

// Every composer of a work we hold gets a row, uncounted until the refresh reaches it. The
// composers are read off `mb_work_composer_idx` one distinct value at a time, so this reads about
// one row per composer, not one per work.
export async function discoverCatalogComposers(): Promise<void> {
  await db.run(sql`
    insert or ignore into catalog_composer (composer_mbid)
    with recursive composer(mbid) as (
      select min(composer_mbid) from mb_work
      union all
      select (select min(composer_mbid) from mb_work where composer_mbid > composer.mbid)
        from composer where composer.mbid is not null
    )
    select mbid from composer where mbid is not null
    union
    select composer_mbid from own_work where composer_mbid is not null and +mb_work_mbid is null`);
}

// Recounts the composers counted longest ago (never counted first) until about `budgetRows` rows
// or `timeMs` are spent. Viewing a composer recounts it too, so the cron mostly catches up with
// composers nobody opened since their recordings changed.
export async function refreshCatalogComposers(
  options: { budgetRows?: number; timeMs?: number; batch?: number; concurrency?: number } = {},
): Promise<{ counted: number; rowsRead: number; uncounted: number }> {
  const budgetRows = options.budgetRows ?? Number.POSITIVE_INFINITY;
  const deadline = Date.now() + (options.timeMs ?? Number.POSITIVE_INFINITY);
  const batch = options.batch ?? 200;
  const concurrency = options.concurrency ?? 4;
  await discoverCatalogComposers();

  let counted = 0;
  let rowsRead = 0;
  const startedAt = new Date();
  while (rowsRead < budgetRows && Date.now() < deadline) {
    const due = await db
      .select({ composerMbid: catalogComposer.composerMbid })
      .from(catalogComposer)
      .where(
        sql`${catalogComposer.countedAt} is null or ${catalogComposer.countedAt} < ${startedAt.getTime()}`,
      )
      .orderBy(asc(catalogComposer.countedAt))
      .limit(batch);
    if (due.length === 0) break;
    for (let start = 0; start < due.length; start += concurrency) {
      if (rowsRead >= budgetRows || Date.now() >= deadline) break;
      await Promise.all(
        due.slice(start, start + concurrency).map(async ({ composerMbid }) => {
          const catalogue = await readComposerCatalogue(composerMbid);
          await recordComposerCounts(composerMbid, catalogue);
          rowsRead += catalogue.rowsRead;
          counted++;
        }),
      );
    }
  }
  const [left] = await db
    .select({ n: sql<number>`count(*)` })
    .from(catalogComposer)
    .where(isNull(catalogComposer.countedAt));
  return { counted, rowsRead, uncounted: left?.n ?? 0 };
}

export type CatalogComposerList = {
  /** Composers with a playable work, as last counted. */
  composers: CatalogComposer[];
  /** Counted, with works in the index but nothing playable: not listed, found by search. */
  withNothingPlayable: number;
  /** Not counted yet, so not listed either. */
  uncounted: number;
  /** When the stalest listed count was taken. */
  countedSince: Date | null;
};

function composerOf(
  artist: typeof mbArtist.$inferSelect,
  images: { url: string; width: number; height: number }[] | null,
  counts: { playable: number | null; recordings: number | null },
): CatalogComposer {
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
    workCount: counts.playable,
    recordingCount: counts.recordings,
  };
}

const FILM_COMPOSER_MBIDS = FILM_COMPOSERS.map((composer) => composer.mbid);

// Film composers aside. Reads one row per listed composer, plus one pass over `catalog_composer`
// (one row per composer) for the counts of those not listed.
export async function readCatalogComposerList(): Promise<CatalogComposerList> {
  const [listed, [summary]] = await Promise.all([
    db
      .select({
        artist: mbArtist,
        images: spotifyArtist.images,
        playable: catalogComposer.playableWorks,
        recordings: catalogComposer.recordings,
        countedAt: catalogComposer.countedAt,
      })
      .from(catalogComposer)
      .innerJoin(mbArtist, eq(mbArtist.mbid, catalogComposer.composerMbid))
      .leftJoin(spotifyArtist, eq(spotifyArtist.spotifyId, mbArtist.spotifyArtistId))
      .where(
        sql`${catalogComposer.playableWorks} > 0 and ${notInArray(catalogComposer.composerMbid, FILM_COMPOSER_MBIDS)}`,
      ),
    db
      .select({
        withNothingPlayable: sql<number>`count(case when ${catalogComposer.playableWorks} = 0 then 1 end)`,
        uncounted: sql<number>`count(case when ${catalogComposer.countedAt} is null then 1 end)`,
      })
      .from(catalogComposer)
      .where(notInArray(catalogComposer.composerMbid, FILM_COMPOSER_MBIDS)),
  ]);
  const countedSince = listed.reduce<Date | null>(
    (oldest, row) =>
      row.countedAt && (!oldest || row.countedAt < oldest) ? row.countedAt : oldest,
    null,
  );
  return {
    composers: listed
      .map((row) =>
        composerOf(row.artist, row.images, { playable: row.playable, recordings: row.recordings }),
      )
      .sort((left, right) => left.sort.localeCompare(right.sort, 'en')),
    withNothingPlayable: summary?.withNothingPlayable ?? 0,
    uncounted: summary?.uncounted ?? 0,
    countedSince,
  };
}

/** The composers' artist rows, with their stored counts (null for one not counted yet). */
export async function readCatalogComposers(mbids: string[]): Promise<Map<string, CatalogComposer>> {
  if (mbids.length === 0) return new Map();
  const rows = await db
    .select({
      artist: mbArtist,
      images: spotifyArtist.images,
      playable: catalogComposer.playableWorks,
      recordings: catalogComposer.recordings,
      countedAt: catalogComposer.countedAt,
    })
    .from(mbArtist)
    .leftJoin(spotifyArtist, eq(spotifyArtist.spotifyId, mbArtist.spotifyArtistId))
    .leftJoin(catalogComposer, eq(catalogComposer.composerMbid, mbArtist.mbid))
    .where(inArray(mbArtist.mbid, mbids));
  return new Map(
    rows.map((row) => [
      row.artist.mbid,
      composerOf(
        row.artist,
        row.images,
        row.countedAt
          ? { playable: row.playable, recordings: row.recordings }
          : { playable: null, recordings: null },
      ),
    ]),
  );
}
