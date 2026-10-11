import { and, eq, exists, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db, type DatabaseExecutor } from './db';
import { jsonList } from './db/chunked';
import { heldWorkLinks } from './db/held-work-links';
import { mbWork, spotifyTrack, trackRecording, trackWorkLink } from './db/schema';
import { lineageOf, rootedSubtreeOf, subtreeOf } from './db/work-tree-sql';
import { ancestry } from './musicbrainz-work-tree';

/**
 * The reader's screens that start from a work rather than from a holding —
 * every recording of this work, more works by this composer, the collection
 * a work belongs to — and the joins that get from a work to the Spotify
 * tracks we can play of it. "Hold" is `heldWorkLinks`'s, everywhere.
 */

/**
 * Every track on the same Spotify albums as these, these included. Liking one
 * movement still puts the whole album's performance of the work on the card,
 * and the rest of it has to be read to be playable. Album-mates with neither a
 * recording nor one of our work links can't land on a card, so they're not
 * read.
 */
export async function findAlbumMateTrackIds(
  spotifyTrackIds: string[],
  database: DatabaseExecutor = db,
): Promise<string[]> {
  if (spotifyTrackIds.length === 0) return [];
  const mates = await database
    .select({ spotifyId: spotifyTrack.spotifyId })
    .from(spotifyTrack)
    .where(
      and(
        sql`${spotifyTrack.spotifyAlbumId} in (select spotify_album_id from spotify_track where spotify_id in (${jsonList(spotifyTrackIds)}))`,
        or(
          exists(
            database
              .select({ one: sql`1` })
              .from(trackRecording)
              .where(eq(trackRecording.spotifyTrackId, spotifyTrack.spotifyId)),
          ),
          exists(
            database
              .select({ one: sql`1` })
              .from(trackWorkLink)
              .where(
                and(
                  eq(trackWorkLink.spotifyTrackId, spotifyTrack.spotifyId),
                  isNotNull(trackWorkLink.workMbid),
                ),
              ),
          ),
        ),
      ),
    );
  return Array.from(new Set([...spotifyTrackIds, ...mates.map((mate) => mate.spotifyId)]));
}

/** The Spotify tracks we hold of this work or of any of its parts. One statement. */
export async function findProviderTracksForWork(
  workMbid: string,
  database: DatabaseExecutor = db,
): Promise<string[]> {
  const links = await heldWorkLinks({ works: subtreeOf(jsonList([workMbid])) }, database);
  return Array.from(new Set(links.map((link) => link.spotifyTrackId)));
}

/**
 * Tracks of other works by the same composer that we hold, filed by the
 * top-level work they belong to and read until about `workLimit` works'
 * worth. Every work tree of the composer is walked in one statement rather
 * than one walk per work: a prolific composer has hundreds of top-level
 * works.
 */
export async function findProviderTracksForComposer(
  composerMbid: string,
  excludeWorkMbid: string,
  workLimit = 12,
  database: DatabaseExecutor = db,
): Promise<string[]> {
  const tree = sql`(with recursive tree(root, mbid) as (select mbid, mbid from mb_work where composer_mbid = ${composerMbid} and parent_mbid is null union select tree.root, child.mbid from mb_work child join tree on child.parent_mbid = tree.mbid) select root, mbid from tree)`;
  const held = heldWorkLinks({ works: sql`(select mbid from ${tree})` }, database);
  const rows = await database.all<{ root: string; spotifyTrackId: string }>(sql`
    select tree.root as root, held.spotify_track_id as spotifyTrackId
      from ${tree} as tree join ${held} as held on held.work_mbid = tree.mbid
      where tree.root not in ${subtreeOf(jsonList([excludeWorkMbid]))}
      order by tree.root`);

  const tracksByRoot = new Map<string, Set<string>>();
  for (const row of rows) {
    tracksByRoot.set(row.root, (tracksByRoot.get(row.root) ?? new Set()).add(row.spotifyTrackId));
  }
  const trackIds: string[] = [];
  for (const tracks of tracksByRoot.values()) {
    if (trackIds.length >= workLimit * 32) break;
    trackIds.push(...tracks);
  }
  return Array.from(new Set(trackIds));
}

/**
 * Which of these works we hold something playable for, counting anything
 * filed beneath them.
 *
 * A collection's parts often have parts of their own — a prelude and fugue
 * is two recordings under one part of the Well-Tempered Clavier — so asking
 * only about the part's own recordings would report a collection as emptier
 * than it is. One statement for the whole set.
 */
export async function findHeldWorkMbids(
  workMbids: string[],
  database: DatabaseExecutor = db,
): Promise<Set<string>> {
  if (workMbids.length === 0) return new Set();
  const tree = rootedSubtreeOf(workMbids);
  const held = heldWorkLinks({ works: sql`(select mbid from ${tree})` }, database);
  const rows = await database.all<{ root: string }>(
    sql`select distinct tree.root as root from ${tree} as tree where tree.mbid in (select work_mbid from ${held})`,
  );
  return new Set(rows.map((row) => row.root));
}

/**
 * The composer a work is shown under: its own, else the nearest ancestor's —
 * the rule `resolveDisplayWork` applies to a card, so a work page and its
 * card name the same composer.
 */
export async function readWorkComposerMbid(
  workMbid: string,
  database: DatabaseExecutor = db,
): Promise<string | null> {
  const lineage = await database
    .select()
    .from(mbWork)
    .where(sql`${mbWork.mbid} in ${lineageOf(jsonList([workMbid]))}`);
  return (
    ancestry(workMbid, new Map(lineage.map((work) => [work.mbid, work]))).find(
      (work) => work.composerMbid,
    )?.composerMbid ?? null
  );
}

/** A work's parent and the parent's other parts, straight from the cache. One statement. */
export async function readWorkCollection(
  workMbid: string,
  database: DatabaseExecutor = db,
): Promise<{
  parentTitle: string;
  siblings: Array<{ mbid: string; title: string; orderingKey: number | null }>;
} | null> {
  const self = alias(mbWork, 'self');
  const parent = alias(mbWork, 'parent');
  const rows = await database
    .select({
      parentTitle: parent.title,
      mbid: mbWork.mbid,
      title: mbWork.title,
      orderingKey: mbWork.orderingKey,
    })
    .from(self)
    .innerJoin(parent, eq(parent.mbid, self.parentMbid))
    .innerJoin(mbWork, eq(mbWork.parentMbid, self.parentMbid))
    .where(eq(self.mbid, workMbid));
  if (rows.length === 0) return null;
  return {
    parentTitle: rows[0].parentTitle,
    siblings: rows
      .map(({ mbid, title, orderingKey }) => ({ mbid, title, orderingKey }))
      .sort(
        (left, right) =>
          (left.orderingKey ?? Number.MAX_SAFE_INTEGER) -
            (right.orderingKey ?? Number.MAX_SAFE_INTEGER) || left.mbid.localeCompare(right.mbid),
      ),
  };
}
