import type { WorkDetail, WorkParent, WorkSibling, WorkSummary } from './library-types';
import { readLibraryCards } from './musicbrainz-library-cards';
import { playedMovementCount, recordingRowOf } from './musicbrainz-library-view';
import {
  findHeldWorkMbids,
  findProviderTracksForComposer,
  findProviderTracksForWork,
  readWorkCollection,
  readWorkComposerMbid,
} from './musicbrainz-work-queries';
import { stripCollectionPrefix } from './prelude';

/**
 * One recording of one work in full, and the two neighbourhoods under it:
 * the other recordings of the same work, and more by the composer.
 *
 * Both neighbourhoods start from MusicBrainz — every recording MusicBrainz
 * relates to this work or its parts, and every other work it attributes to
 * this composer — and are then narrowed to what the provider can actually
 * play. A recording MusicBrainz knows and Spotify does not is not a
 * recording this reader can offer.
 */
export async function getMusicBrainzWorkDetail(
  workMbid: string,
  recordingMbid: string | null,
  likedTrackIds: string[] = [],
): Promise<WorkDetail | null> {
  const liked = new Set(likedTrackIds);
  // The card for this work names its composer by the same rule
  // `readWorkComposerMbid` reads, so "more by the composer" can be read
  // alongside the work's own recordings instead of after them.
  const [forThisWork, moreByComposer] = await Promise.all([
    findProviderTracksForWork(workMbid).then(async (trackIds) =>
      trackIds.length === 0
        ? []
        : (await readLibraryCards(trackIds, liked)).works.filter(
            (card) => card.workId === workMbid,
          ),
    ),
    readWorkComposerMbid(workMbid).then((composerMbid) =>
      composerMbid ? worksByComposer(composerMbid, workMbid, liked) : [],
    ),
  ]);
  if (forThisWork.length === 0) return null;

  // The recording asked for, or the fullest holding of the work — a choice
  // between things we actually have, not a guess at which is best.
  const chosen =
    forThisWork.find((card) => card.recordingId === recordingMbid) ??
    [...forThisWork].sort(
      (left, right) => playedMovementCount(right) - playedMovementCount(left),
    )[0];

  return {
    work: chosen,
    others: forThisWork.filter((card) => card.id !== chosen.id).map(recordingRowOf),
    // A composer the cache has no artist for is not on the card either.
    moreByComposer: chosen.composerId ? moreByComposer : [],
  };
}

async function worksByComposer(
  composerMbid: string,
  excludeWorkMbid: string,
  liked: Set<string>,
): Promise<WorkSummary[]> {
  const trackIds = await findProviderTracksForComposer(composerMbid, excludeWorkMbid);
  if (trackIds.length === 0) return [];
  const { works } = await readLibraryCards(trackIds, liked);
  // The fullest holding of each work, so the list is one row per work.
  const fullest = new Map<string, (typeof works)[number]>();
  const tracksByWork = new Map<string, Set<string>>();
  for (const card of works) {
    if (!card.workId || card.workId === excludeWorkMbid) continue;
    const tracks = tracksByWork.get(card.workId) ?? new Set<string>();
    for (const movement of card.movements) if (movement.trackId) tracks.add(movement.trackId);
    tracksByWork.set(card.workId, tracks);
    const held = fullest.get(card.workId);
    if (!held || playedMovementCount(card) > playedMovementCount(held)) {
      fullest.set(card.workId, card);
    }
  }
  return Array.from(fullest.values()).map((card) => ({
    workId: card.workId!,
    recordingId: card.recordingId ?? card.id,
    title: card.title,
    nickname: card.nickname,
    catalog: card.catalog,
    year: card.year,
    cover: card.cover,
    album: card.album,
    performer: card.performer,
    ensemble: card.ensemble,
    movementCount: playedMovementCount(card),
    partCount: card.movements.length,
    unmatched: false,
    movements: card.movements.map((movement) => ({
      roman: movement.roman,
      name: movement.name,
      duration: movement.duration,
      missing: movement.missing,
    })),
    trackIds: Array.from(tracksByWork.get(card.workId!) ?? []),
  }));
}

/**
 * The collection a work belongs to, as MusicBrainz files it, and which of
 * its parts we can play.
 *
 * Parts MusicBrainz lists that we hold nothing for come back with a null
 * identity. A collection showing twenty-three of its forty-eight parts
 * should say so rather than looking like a complete list of twenty-three.
 */
export async function getMusicBrainzWorkParent(workMbid: string): Promise<WorkParent | null> {
  const collection = await readWorkCollection(workMbid);
  if (!collection) return null;

  const held = await findHeldWorkMbids(collection.siblings.map((sibling) => sibling.mbid));
  const siblings: WorkSibling[] = collection.siblings.map((sibling) => ({
    workId: held.has(sibling.mbid) ? sibling.mbid : null,
    title: stripCollectionPrefix(sibling.title, collection.parentTitle),
    ordering: sibling.orderingKey,
    isCurrent: sibling.mbid === workMbid,
  }));
  return {
    title: collection.parentTitle,
    siblings,
    held: siblings.filter((sibling) => sibling.workId !== null).length,
  };
}
