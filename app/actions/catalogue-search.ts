'use server';

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from '@/lib/db';
import { composer, recordingV2, work, workCatalogV2 } from '@/lib/db/schema';
import { parseCatalogueQuery } from '@/lib/catalogue-query';

export interface WorkSearchHit {
  workId: number;
  title: string;
  nickname: string | null;
  composerId: number;
  composerName: string;
  /** The reference the search matched on, which may not be the primary one. */
  matchedOn: string | null;
  /** Every reference the work carries, so the reader can see what it is called. */
  references: string[];
  recordingCount: number;
}

/**
 * Find works by catalogue reference or by title.
 *
 * A catalogue reference matches *any* of a work's references, not only the
 * one shown on its card. That is the whole point of importing alternates from
 * MusicBrainz: a Scarlatti sonata carries Kk. 9, L 413 and K 9, and a reader
 * who knows the Longo number should find it even though the card says Kk.
 *
 * Text search is deliberately plain — title, nickname, composer — because a
 * cleverer ranking would need tuning against a corpus we do not have, and a
 * list that is merely unsorted is better than one that is confidently wrong.
 */
export async function searchWorks(rawQuery: string, limit = 40): Promise<WorkSearchHit[]> {
  const parsed = parseCatalogueQuery(rawQuery);
  if (parsed.kind === 'text' && parsed.text.length < 2) return [];

  const matching = alias(workCatalogV2, 'matching_catalog');

  const condition =
    parsed.kind === 'reference'
      ? and(
          eq(matching.normalizedSystem, parsed.system),
          eq(matching.normalizedNumber, parsed.number),
        )
      : parsed.kind === 'number'
        ? eq(matching.normalizedNumber, parsed.number)
        : or(
            sql`lower(${work.title}) like ${'%' + parsed.text + '%'}`,
            sql`lower(coalesce(${work.nickname}, '')) like ${'%' + parsed.text + '%'}`,
            sql`lower(${composer.name}) like ${'%' + parsed.text + '%'}`,
          );

  const rows = await db
    .selectDistinct({
      workId: work.id,
      title: work.title,
      nickname: work.nickname,
      composerId: composer.id,
      composerName: composer.name,
      matchedOn:
        parsed.kind === 'text'
          ? sql<string | null>`null`
          : sql<string | null>`${matching.system} || ' ' || ${matching.number}`,
      recordingCount: sql<number>`(select count(*) from ${recordingV2} where ${recordingV2.workId} = ${work.id})`,
    })
    .from(work)
    .innerJoin(composer, eq(composer.id, work.composerId))
    .leftJoin(matching, eq(matching.workId, work.id))
    .where(condition)
    .limit(limit);

  if (rows.length === 0) return [];

  const references = new Map<number, string[]>();
  const refRows = await db
    .select({
      workId: workCatalogV2.workId,
      system: workCatalogV2.system,
      number: workCatalogV2.number,
    })
    .from(workCatalogV2)
    .where(
      inArray(
        workCatalogV2.workId,
        rows.map((row) => row.workId),
      ),
    );
  for (const row of refRows) {
    references.set(row.workId, [
      ...(references.get(row.workId) ?? []),
      `${row.system} ${row.number}`,
    ]);
  }

  return rows.map((row) => ({ ...row, references: references.get(row.workId) ?? [] }));
}
