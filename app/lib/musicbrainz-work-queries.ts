import { and, eq, exists, isNotNull, or, sql } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './db';
import { jsonList } from './db/chunked';
import { heldWorkLinks } from './db/held-work-links';
import { mbWork, spotifyTrack, trackRecording, trackWorkLink } from './db/schema';
import { lineageOf, subtreeOf } from './db/work-tree-sql';
import { ancestry } from './musicbrainz-work-tree';

/** "Hold" is `heldWorkLinks`'s, everywhere. */

// Liking one movement still puts the album's whole performance on the card. Album-mates with no
// recording or work link can't land on a card, so they're not read.
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

export async function findProviderTracksForWork(
  workMbid: string,
  database: DatabaseExecutor = db,
): Promise<string[]> {
  const links = await heldWorkLinks({ works: subtreeOf(jsonList([workMbid])) }, database);
  return Array.from(new Set(links.map((link) => link.spotifyTrackId)));
}

/**
 * Every work tree of the composer is walked in one statement: a prolific composer has hundreds of
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

/** The rule `resolveDisplayWork` applies, so a work page and its card name the same composer. */
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
