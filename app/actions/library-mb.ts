'use server';

import {
  findProviderTracksForComposer,
  findProviderTracksForWork,
  loadMusicBrainzLibraryFacts,
} from './library-musicbrainz';
import type { OtherRecording, WorkDetail, WorkSummary } from './library';
import { formatDuration, type LibraryWork } from '@/lib/prelude';
import { projectMusicBrainzLibrary } from '@/lib/musicbrainz-library';
import {
  musicBrainzLibraryView,
  playedMovementCount,
  type MusicBrainzLibrary,
} from '@/lib/musicbrainz-library-view';

/**
 * The library as MusicBrainz has it: cards for what it can show, and a named
 * gap for every held track it cannot. Reads only the Spotify provider
 * tables, `track_recording` and `mb_*`, and stores nothing — the liked IDs
 * arrive from the caller and are not written down.
 */
export async function getMusicBrainzLibrary(
  likedTrackIds: string[],
  addedAt: Array<[string, string]> = [],
): Promise<MusicBrainzLibrary> {
  const facts = await loadMusicBrainzLibraryFacts(likedTrackIds);
  return musicBrainzLibraryView(
    projectMusicBrainzLibrary(facts),
    new Set(likedTrackIds),
    new Map(addedAt),
  );
}

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
  const trackIds = await findProviderTracksForWork(workMbid);
  if (trackIds.length === 0) return null;

  const { works } = musicBrainzLibraryView(
    projectMusicBrainzLibrary(await loadMusicBrainzLibraryFacts(trackIds)),
    liked,
  );
  const forThisWork = works.filter((card) => card.workId === workMbid);
  if (forThisWork.length === 0) return null;

  // The recording asked for, or the fullest holding of the work — a choice
  // between things we actually have, not a guess at which is best.
  const chosen =
    forThisWork.find((card) => card.recordingId === recordingMbid) ??
    [...forThisWork].sort(
      (left, right) => playedMovementCount(right) - playedMovementCount(left),
    )[0];

  const others: OtherRecording[] = forThisWork
    .filter((card) => card.id !== chosen.id)
    .map((card) => ({
      recordingId: card.recordingId ?? card.id,
      albumId: card.movements.find((movement) => movement.trackId)?.trackId ?? card.id,
      album: card.album,
      cover: card.cover,
      year: card.year,
      performer: card.performer,
      ensemble: card.ensemble,
      durationMs: totalDuration(card),
      duration: totalDuration(card) === null ? null : formatDuration(totalDuration(card)!),
      unmatched: false,
      // Spotify popularity belongs to a track, not to a MusicBrainz
      // recording, and nothing here has aggregated it yet. Unranked is the
      // honest answer, and the screen already says so.
      popularity: null,
      tint: card.tint,
    }));

  const moreByComposer = chosen.composerId
    ? await worksByComposer(chosen.composerId, workMbid, liked)
    : [];

  return { work: chosen, others, moreByComposer };
}

function totalDuration(work: LibraryWork): number | null {
  const played = work.movements.filter((movement) => movement.durationMs !== null);
  return played.length === 0 ? null : played.reduce((sum, m) => sum + (m.durationMs ?? 0), 0);
}

async function worksByComposer(
  composerMbid: string,
  excludeWorkMbid: string,
  liked: Set<string>,
): Promise<WorkSummary[]> {
  const trackIds = await findProviderTracksForComposer(composerMbid, excludeWorkMbid);
  if (trackIds.length === 0) return [];
  const { works } = musicBrainzLibraryView(
    projectMusicBrainzLibrary(await loadMusicBrainzLibraryFacts(trackIds)),
    liked,
  );
  // The fullest holding of each work, so the list is one row per work.
  const fullest = new Map<string, (typeof works)[number]>();
  for (const card of works) {
    if (!card.workId || card.workId === excludeWorkMbid) continue;
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
  }));
}
