'use server';

import { count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  composer,
  mbArtist,
  mbWork,
  metadataMigrationAudit,
  spotifyTrack,
  trackWorkPartV2,
  work,
  workPartV2,
} from '@/lib/db/schema';
import { resolveWorkLevel, type MatchedPart } from '@/lib/musicbrainz';
import { titlesAreCompatible } from '@/lib/metadata-matching';
import { checkAuth } from './auth';

/** A count the desk shows, with the question it answers. */
export type Gap = {
  id: string;
  /** What is missing, in the reader's terms. */
  label: string;
  count: number;
  /** Where to go to work on it, when there is somewhere. */
  tab?: 'queue' | 'works' | 'composers';
};

export type CatalogueHealth = {
  tracks: number;
  tracksMatched: number;
  works: number;
  worksLinked: number;
  parts: number;
  partsLinked: number;
  composers: number;
  composersLinked: number;
  importedCatalogues: number;
  gaps: Gap[];
  disagreementsByField: { field: DisagreementField; label: string; count: number }[];
};

/**
 * The fields where a difference is still a question.
 *
 * `work_type` and `part_title` used to be here and no longer are. Both of our
 * values came from the parser reading a Spotify track title, so a difference
 * with MusicBrainz was never two opinions of equal standing — one side had
 * checked and the other had guessed. They are settled by policy now:
 * MusicBrainz wins, except where its value carries a catalogue number or
 * merely abbreviates ours, and the parser's reading is kept in
 * `work.parser_form` and `work_part_v2.parser_title`. Listing thousands of
 * them as decisions asked a person to re-make the same judgement every time.
 *
 * A composer's dates are different: ours were not guessed from a track
 * title, so a disagreement there is worth a look.
 */
export type DisagreementField = 'birth_year' | 'death_year';

/** A variant reading: what we hold, and what MusicBrainz holds instead. */
export type Disagreement = {
  key: string;
  field: DisagreementField;
  entityId: number;
  /** Where this sits in the catalogue, for someone deciding. */
  context: string;
  ours: string;
  theirs: string;
};

const FIELD_LABELS: Record<DisagreementField, string> = {
  birth_year: 'composer born',
  death_year: 'composer died',
};

export async function getCatalogueHealth(): Promise<CatalogueHealth> {
  await checkAuth();

  const [totals] = await db
    .select({
      tracks: sql<number>`(select count(*) from spotify_track)`,
      tracksMatched: sql<number>`(select count(*) from track_recording)`,
      works: sql<number>`(select count(*) from work)`,
      worksLinked: sql<number>`(select count(musicbrainz_id) from work)`,
      parts: sql<number>`(select count(*) from work_part_v2)`,
      partsLinked: sql<number>`(select count(musicbrainz_id) from work_part_v2)`,
      composers: sql<number>`(select count(*) from composer)`,
      composersLinked: sql<number>`(select count(musicbrainz_id) from composer)`,
      importedCatalogues: sql<number>`(select count(*) from work_catalog_v2 where source = 'musicbrainz')`,
    })
    .from(sql`(select 1)`);

  const [unmatchedTracks] = await db
    .select({ n: count() })
    .from(spotifyTrack)
    .leftJoin(trackWorkPartV2, eq(trackWorkPartV2.spotifyTrackId, spotifyTrack.spotifyId))
    .where(isNull(trackWorkPartV2.workPartId));

  const [unnamedParts] = await db
    .select({ n: count() })
    .from(workPartV2)
    .where(isNull(workPartV2.title));

  const [worksWithoutForm] = await db.select({ n: count() }).from(work).where(isNull(work.form));

  const [composersWithoutDates] = await db
    .select({ n: count() })
    .from(composer)
    .where(isNull(composer.birthYear));

  const [flaggedLinks] = await db
    .select({ n: count() })
    .from(trackWorkPartV2)
    .where(eq(trackWorkPartV2.matchStatus, 'needs_review'));

  const disagreements = await loadDisagreements();
  const byField = new Map<DisagreementField, number>();
  for (const row of disagreements) byField.set(row.field, (byField.get(row.field) ?? 0) + 1);

  return {
    ...totals,
    gaps: [
      {
        id: 'unmatched',
        label: 'tracks not matched to a work',
        count: unmatchedTracks.n,
        tab: 'queue',
      },
      { id: 'unnamed', label: 'movements with no title', count: unnamedParts.n, tab: 'works' },
      { id: 'form', label: 'works with no form', count: worksWithoutForm.n, tab: 'works' },
      {
        id: 'dates',
        label: 'composers with no birth year',
        count: composersWithoutDates.n,
        tab: 'composers',
      },
      { id: 'flagged', label: 'links flagged for review', count: flaggedLinks.n, tab: 'queue' },
    ],
    disagreementsByField: (Object.keys(FIELD_LABELS) as DisagreementField[])
      .map((field) => ({ field, label: FIELD_LABELS[field], count: byField.get(field) ?? 0 }))
      .filter((row) => row.count > 0),
  };
}

/**
 * Every field where we and MusicBrainz both hold a value and the values differ.
 *
 * Read in the notation editors use for variant readings: what we hold, then the
 * bracket, then the other source's reading. Neither is assumed correct — our
 * form vocabulary is frequently the more specific of the two.
 */
async function loadDisagreements(): Promise<Disagreement[]> {
  const settled = new Set(
    (
      await db
        .select({
          entityType: metadataMigrationAudit.entityType,
          sourceId: metadataMigrationAudit.sourceId,
        })
        .from(metadataMigrationAudit)
        .where(
          sql`${metadataMigrationAudit.decision} in ('musicbrainz_accepted', 'musicbrainz_rejected')`,
        )
    ).map((row) => `${row.entityType}:${row.sourceId}`),
  );

  const out: Disagreement[] = [];

  const years = await db
    .select({
      id: composer.id,
      name: composer.name,
      birth: composer.birthYear,
      death: composer.deathYear,
      mbBirth: mbArtist.beginYear,
      mbDeath: mbArtist.endYear,
    })
    .from(composer)
    .innerJoin(mbArtist, eq(mbArtist.mbid, composer.musicbrainzId));

  for (const row of years) {
    for (const field of ['birth_year', 'death_year'] as const) {
      const held = field === 'birth_year' ? row.birth : row.death;
      const theirs = field === 'birth_year' ? row.mbBirth : row.mbDeath;
      if (held == null || theirs == null || held === theirs) continue;
      if (settled.has(`composer_${field}:${row.id}`)) continue;
      out.push({
        key: `${field}:${row.id}`,
        field,
        entityId: row.id,
        context: row.name,
        ours: String(held),
        theirs: String(theirs),
      });
    }
  }

  return out;
}

export async function getDisagreements(
  field?: DisagreementField,
  limit = 50,
): Promise<{ rows: Disagreement[]; total: number }> {
  await checkAuth();
  const all = await loadDisagreements();
  const filtered = field ? all.filter((row) => row.field === field) : all;
  return { rows: filtered.slice(0, limit), total: filtered.length };
}

const AUDIT_ENTITY: Record<DisagreementField, string> = {
  birth_year: 'composer_birth_year',
  death_year: 'composer_death_year',
};

/**
 * Settle one variant reading.
 *
 * `theirs` writes MusicBrainz's value into our column; `ours` leaves the value
 * alone. Both record why, so the row leaves the queue with a reason attached
 * rather than simply disappearing.
 */
export async function resolveDisagreement(
  field: DisagreementField,
  entityId: number,
  choice: 'ours' | 'theirs',
  value: string,
): Promise<void> {
  await checkAuth();

  if (choice === 'theirs') {
    if (field === 'birth_year') {
      await db
        .update(composer)
        .set({ birthYear: Number(value) })
        .where(eq(composer.id, entityId));
    } else if (field === 'death_year') {
      await db
        .update(composer)
        .set({ deathYear: Number(value) })
        .where(eq(composer.id, entityId));
    } else if (field === 'work_type') {
      await db.update(work).set({ form: value }).where(eq(work.id, entityId));
    } else {
      await db.update(workPartV2).set({ title: value }).where(eq(workPartV2.id, entityId));
    }
  }

  await db
    .insert(metadataMigrationAudit)
    .values({
      entityType: AUDIT_ENTITY[field],
      sourceId: String(entityId),
      decision: choice === 'theirs' ? 'musicbrainz_accepted' : 'musicbrainz_rejected',
      reason:
        choice === 'theirs'
          ? `Took MusicBrainz's reading: ${value}`
          : `Kept our reading against MusicBrainz's ${value}`,
    })
    .onConflictDoUpdate({
      target: [metadataMigrationAudit.entityType, metadataMigrationAudit.sourceId],
      set: {
        decision: choice === 'theirs' ? 'musicbrainz_accepted' : 'musicbrainz_rejected',
        reason: `Settled ${new Date().toISOString().slice(0, 10)}`,
      },
    });
}

/**
 * Groups of our works that resolve onto a single MusicBrainz work.
 *
 * Resolved the same way the backfill resolves them, not by reading the raw
 * parent of each part: MusicBrainz nests works, so two of our works can share
 * a grandparent while being entirely different pieces. Grouping on the raw
 * parent reports Haydn's 82nd and 87th symphonies as the same thing.
 *
 * What survives that is a real question — two rows here describing one work
 * there — and it is almost always the same piece entered twice, once as the
 * collection and once as the individual piece.
 */
export async function getContestedWorks(limit = 40) {
  await checkAuth();

  const rows = await db
    .select({
      workId: workPartV2.workId,
      workTitle: work.title,
      workMbid: work.musicbrainzId,
      composerName: composer.name,
      partId: workPartV2.id,
      leafId: workPartV2.musicbrainzId,
      // A part with no parent in MusicBrainz is its own level, which is what
      // resolveWorkLevel expects when leaf and parent are the same.
      parentId: sql<string>`coalesce(${mbWork.parentMbid}, ${mbWork.mbid})`,
      partTitle: mbWork.title,
    })
    .from(workPartV2)
    .innerJoin(work, eq(work.id, workPartV2.workId))
    .innerJoin(composer, eq(composer.id, work.composerId))
    .innerJoin(mbWork, eq(mbWork.mbid, workPartV2.musicbrainzId))
    .where(isNotNull(workPartV2.musicbrainzId));

  const partTitles = new Map(rows.map((row) => [row.partId, row.partTitle]));

  const byWork = new Map<
    number,
    { title: string; composerName: string; linked: boolean; parts: MatchedPart[] }
  >();
  for (const row of rows) {
    const entry = byWork.get(row.workId) ?? {
      title: row.workTitle,
      composerName: row.composerName,
      linked: row.workMbid !== null,
      parts: [],
    };
    entry.parts.push({
      leafId: row.leafId as string,
      parentId: row.parentId,
      title: partTitles.get(row.partId) ?? '',
    });
    byWork.set(row.workId, entry);
  }

  const claims = new Map<string, { id: number; title: string; composerName: string }[]>();
  for (const [workId, entry] of byWork) {
    const chosen = resolveWorkLevel(entry.title, entry.parts, titlesAreCompatible);
    if (!chosen) continue;
    const list = claims.get(chosen) ?? [];
    list.push({ id: workId, title: entry.title, composerName: entry.composerName });
    claims.set(chosen, list);
  }

  return [...claims.entries()]
    .filter(([, works]) => works.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, limit)
    .map(([mbid, works]) => ({ mbid, works }));
}

/** Kept for the header; the old shape the tabs still read. */
export async function getLinkedCounts() {
  await checkAuth();
  const [row] = await db
    .select({ linked: count() })
    .from(work)
    .where(isNotNull(work.musicbrainzId));
  return row.linked;
}
