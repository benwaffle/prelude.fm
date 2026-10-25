'use server';

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jsonList } from '@/lib/db/chunked';
import { heldWorkLinks } from '@/lib/db/held-work-links';
import { mbArtist, mbWorkCatalogue } from '@/lib/db/schema';
import { readWorkCatalogue, readWorkNeighbourhood, subtreeOf } from '@/lib/db/work-tree-sql';
import { matchingWorks, workSearchQuery } from '@/lib/db/work-search';
import { filmScoreInputs } from '@/lib/film-score-inputs';
import { FILM_COMPOSERS, filmScoreReason } from '@/lib/film-scores';
import { parseCatalogueQuery } from '@/lib/catalogue-query';
import { shapeHeldCatalogue, type ShapedCatalogueWork } from '@/lib/musicbrainz-catalogue-shape';
import {
  readCatalogComposerList,
  readCatalogComposers,
  readComposerCatalogue,
  recordComposerCounts,
  withoutFilmScores,
  type CatalogComposerList,
} from '@/lib/musicbrainz-composer-catalogue';
import { indexWorks, workAttributes } from '@/lib/musicbrainz-display-work';
import { readLibraryCards } from '@/lib/musicbrainz-library-cards';
import { recordingRowOf } from '@/lib/musicbrainz-library-view';
import { ancestry } from '@/lib/musicbrainz-work-tree';
import { findProviderTracksForWork } from '@/lib/musicbrainz-work-queries';
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
  references: string[];
  recordingCount: number;
}

// The works we can play under these, at the library's level (`resolveDisplayWork`).
async function heldCatalogue(seedWorkMbids: string[]): Promise<ShapedCatalogueWork[]> {
  if (seedWorkMbids.length === 0) return [];
  const held = await heldWorkLinks({ works: subtreeOf(jsonList(seedWorkMbids)) });
  if (held.length === 0) return [];

  // One generation of children so the level rule can tell a work with parts from a leaf.
  const [works, filmScoreInputOf] = await Promise.all([
    readWorkNeighbourhood(held.map((link) => link.workMbid)),
    filmScoreInputs(held.map((link) => link.spotifyTrackId)),
  ]);
  const references = await readWorkCatalogue(works.map((work) => work.mbid));
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

// Composers with a playable work, as last counted (see `catalog_composer`). Those with nothing
// playable, and those not counted yet, are counted but not listed; the search finds them.
export async function getMusicBrainzCatalogComposers(): Promise<CatalogComposerList> {
  return readCatalogComposerList();
}

// The composer's whole catalogue, counted afresh; the count is kept for the composer list.
export async function getMusicBrainzCatalogWorks(
  composerMbid: string,
): Promise<{ composer: CatalogComposer | null; works: CatalogWork[] }> {
  const [catalogue, composers] = await Promise.all([
    readComposerCatalogue(composerMbid),
    readCatalogComposers([composerMbid]),
  ]);
  await recordComposerCounts(composerMbid, catalogue);
  const composer = composers.get(composerMbid);
  return {
    composer: composer
      ? { ...composer, workCount: catalogue.playable, recordingCount: catalogue.recordings }
      : null,
    works: catalogue.works,
  };
}

/** Scoped to one work: this runs on every click in the third column. */
export async function getMusicBrainzCatalogWorkHeader(
  workMbid: string,
): Promise<CatalogWorkHeader | null> {
  const neighbourhood = await readWorkNeighbourhood([workMbid]);
  const byMbid = new Map(neighbourhood.map((node) => [node.mbid, node]));
  const work = byMbid.get(workMbid);
  if (!work) return null;

  const lineage = ancestry(workMbid, byMbid);
  const references = await readWorkCatalogue(lineage.map((node) => node.mbid));
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

// A reference matches any of a work's references (Kk. 9 and L 413). Only playable works are
// returned.
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
        : await searchWorkText(parsed.text, limit * 8);

  const wanted = new Set(matchedWorkMbids.map((row) => row.workMbid));
  if (wanted.size === 0) return [];

  const shaped = await heldCatalogue([...wanted]);
  // The query may have matched the reference on the piece while the clicked work is the same piece;
  // match either way round.
  const hits = shaped.filter(
    (work) => wanted.has(work.mbid) || (work.reference && wanted.has(work.reference.workMbid)),
  );
  const [references, composerNames] = await Promise.all([
    readWorkCatalogue(hits.flatMap((work) => (work.reference ? [work.reference.workMbid] : []))),
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

// The full-text index, best match first (`app/lib/db/work-search.ts`).
async function searchWorkText(text: string, limit: number): Promise<{ workMbid: string }[]> {
  const query = workSearchQuery(text);
  if (!query) return [];
  return db.all<{ workMbid: string }>(
    sql`select mbid as workMbid from (${matchingWorks(query, limit)})`,
  );
}

const FILM_COMPOSER_MBIDS = new Set(FILM_COMPOSERS.map((composer) => composer.mbid));

// Composers whose name matches, best first, playable or not: the list shows only those with
// something playable, so this is how the rest are reached (`catalog_composer_search`).
export async function searchCatalogComposers(
  rawQuery: string,
  limit = 12,
): Promise<CatalogComposer[]> {
  const query = workSearchQuery(rawQuery);
  if (!query || rawQuery.trim().length < 2) return [];
  const rows = await db.all<{ mbid: string }>(sql`
    select mbid from catalog_composer_search where catalog_composer_search match ${query}
     order by rank limit ${limit + FILM_COMPOSER_MBIDS.size}`);
  const mbids = rows.map((row) => row.mbid).filter((mbid) => !FILM_COMPOSER_MBIDS.has(mbid));
  const composers = await readCatalogComposers(mbids);
  return mbids.flatMap((mbid) => composers.get(mbid) ?? []).slice(0, limit);
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
      // Compare milliseconds, not "m:ss" text: as strings "9:59" sorts above "10:00".
      .sort(
        (left, right) =>
          right.recording.liked - left.recording.liked || right.durationMs - left.durationMs,
      )
      .map(({ recording }) => recording)
  );
}
