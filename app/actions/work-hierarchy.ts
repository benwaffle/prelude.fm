'use server';

import { asc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from '@/lib/db';
import { mbWork, work } from '@/lib/db/schema';
import { stripCollectionPrefix } from '@/lib/prelude';

export interface WorkSibling {
  /** Our work, when we hold one for this part of the collection. */
  workId: string | null;
  title: string;
  /** Its position among the parent's parts, as MusicBrainz orders them. */
  ordering: number | null;
  isCurrent: boolean;
}

export interface WorkParent {
  title: string;
  /** Every part MusicBrainz lists, including ones we do not have. */
  siblings: WorkSibling[];
  /** How many of those parts we hold a work for. */
  held: number;
}

/**
 * The collection a work belongs to, and what else is in it.
 *
 * "Prelude and Fugue No. 1 in C major" is one of forty-eight in The
 * Well-Tempered Clavier, and until now nothing said so: our own model is
 * flat, and the parent relationship exists only in MusicBrainz's tree.
 *
 * Siblings MusicBrainz lists that we hold no work for are returned too, with
 * a null id. A collection showing twenty-three of its forty-eight parts
 * should say so rather than looking like a complete list of twenty-three —
 * the gap is the point.
 */
export async function getWorkParent(identity: string): Promise<WorkParent | null> {
  const workId = Number(identity);
  const [self] = await db
    .select({ mbid: work.musicbrainzId })
    .from(work)
    .where(eq(work.id, workId))
    .limit(1);
  if (!self?.mbid) return null;

  const [node] = await db
    .select({ parentMbid: mbWork.parentMbid })
    .from(mbWork)
    .where(eq(mbWork.mbid, self.mbid))
    .limit(1);
  if (!node?.parentMbid) return null;

  const [parent] = await db
    .select({ title: mbWork.title })
    .from(mbWork)
    .where(eq(mbWork.mbid, node.parentMbid))
    .limit(1);
  if (!parent) return null;

  const children = alias(mbWork, 'child');
  const rows = await db
    .select({
      mbid: children.mbid,
      title: children.title,
      ordering: children.orderingKey,
      workId: work.id,
    })
    .from(children)
    .leftJoin(work, eq(work.musicbrainzId, children.mbid))
    .where(eq(children.parentMbid, node.parentMbid))
    .orderBy(asc(children.orderingKey));

  const siblings: WorkSibling[] = rows.map((row) => ({
    workId: row.workId === null ? null : String(row.workId),
    title: stripCollectionPrefix(row.title, parent.title),
    ordering: row.ordering,
    isCurrent: row.mbid === self.mbid,
  }));

  return {
    title: parent.title,
    siblings,
    held: siblings.filter((sibling) => sibling.workId !== null).length,
  };
}
