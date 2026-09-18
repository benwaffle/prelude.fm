'use server';

import { and, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  composer,
  metadataMigrationAudit,
  musicbrainzFact,
  spotifyTrack,
  trackWorkPartV2,
  work,
  workPartV2,
} from '@/lib/db/schema';
import {
  formFromWorkType,
  movementTitleFromMusicBrainz,
  textuallyEqual,
} from '@/lib/musicbrainz-promotion';
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

export type DisagreementField = 'birth_year' | 'death_year' | 'work_type' | 'part_title';

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
  work_type: 'work form',
  part_title: 'movement title',
};

export async function getCatalogueHealth(): Promise<CatalogueHealth> {
  await checkAuth();

  const [totals] = await db
    .select({
      tracks: sql<number>`(select count(*) from spotify_track)`,
      tracksMatched: sql<number>`(select count(mb_recording_id) from spotify_track)`,
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
      field: musicbrainzFact.field,
      value: musicbrainzFact.value,
    })
    .from(musicbrainzFact)
    .innerJoin(composer, eq(composer.id, musicbrainzFact.entityId))
    .where(
      and(
        eq(musicbrainzFact.entityType, 'composer'),
        sql`${musicbrainzFact.field} in ('birth_year', 'death_year')`,
      ),
    );
  for (const row of years) {
    const field = row.field as 'birth_year' | 'death_year';
    const held = field === 'birth_year' ? row.birth : row.death;
    if (held == null || String(held) === row.value.trim()) continue;
    if (settled.has(`composer_${field}:${row.id}`)) continue;
    out.push({
      key: `${field}:${row.id}`,
      field,
      entityId: row.id,
      context: row.name,
      ours: String(held),
      theirs: row.value,
    });
  }

  const forms = await db
    .select({ id: work.id, title: work.title, form: work.form, value: musicbrainzFact.value })
    .from(musicbrainzFact)
    .innerJoin(work, eq(work.id, musicbrainzFact.entityId))
    .where(and(eq(musicbrainzFact.entityType, 'work'), eq(musicbrainzFact.field, 'work_type')));
  for (const row of forms) {
    const incoming = formFromWorkType(row.value);
    if (!row.form || textuallyEqual(row.form, incoming)) continue;
    if (settled.has(`work_form:${row.id}`)) continue;
    out.push({
      key: `work_type:${row.id}`,
      field: 'work_type',
      entityId: row.id,
      context: row.title,
      ours: row.form,
      theirs: incoming,
    });
  }

  const titles = await db
    .select({
      id: workPartV2.id,
      label: workPartV2.label,
      title: workPartV2.title,
      workTitle: work.title,
      value: musicbrainzFact.value,
    })
    .from(musicbrainzFact)
    .innerJoin(workPartV2, eq(workPartV2.id, musicbrainzFact.entityId))
    .innerJoin(work, eq(work.id, workPartV2.workId))
    .where(
      and(eq(musicbrainzFact.entityType, 'work_part'), eq(musicbrainzFact.field, 'part_title')),
    );
  for (const row of titles) {
    const incoming = movementTitleFromMusicBrainz(row.value, row.label);
    if (!incoming || !row.title || textuallyEqual(row.title, incoming)) continue;
    if (settled.has(`work_part_title:${row.id}`)) continue;
    out.push({
      key: `part_title:${row.id}`,
      field: 'part_title',
      entityId: row.id,
      context: `${row.workTitle}${row.label ? ` · ${row.label}` : ''}`,
      ours: row.title,
      theirs: incoming,
    });
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
  work_type: 'work_form',
  part_title: 'work_part_title',
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

/** Works that several of ours resolve onto — usually duplicates of each other. */
export async function getContestedWorks(limit = 40) {
  await checkAuth();
  const rows = await db
    .select({
      mbid: musicbrainzFact.value,
      workId: workPartV2.workId,
      title: work.title,
      composerName: composer.name,
    })
    .from(musicbrainzFact)
    .innerJoin(workPartV2, eq(workPartV2.id, musicbrainzFact.entityId))
    .innerJoin(work, eq(work.id, workPartV2.workId))
    .innerJoin(composer, eq(composer.id, work.composerId))
    .where(
      and(eq(musicbrainzFact.entityType, 'work_part'), eq(musicbrainzFact.field, 'mb_parent_work')),
    );

  const groups = new Map<string, Map<number, { title: string; composerName: string }>>();
  for (const row of rows) {
    const group = groups.get(row.mbid) ?? new Map();
    group.set(row.workId, { title: row.title, composerName: row.composerName });
    groups.set(row.mbid, group);
  }

  const unlinked = new Set(
    (await db.select({ id: work.id }).from(work).where(isNull(work.musicbrainzId))).map(
      (r) => r.id,
    ),
  );

  return [...groups.entries()]
    .filter(
      ([, members]) => members.size > 1 && [...members.keys()].every((id) => unlinked.has(id)),
    )
    .slice(0, limit)
    .map(([mbid, members]) => ({
      mbid,
      works: [...members.entries()].map(([id, info]) => ({ id, ...info })),
    }));
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
