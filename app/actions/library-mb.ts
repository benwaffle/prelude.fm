'use server';

import type { WorkDetail, WorkParent } from '@/lib/library-types';
import { readLibraryCards } from '@/lib/musicbrainz-library-cards';
import { keepLikedHoldings, type MusicBrainzLibrary } from '@/lib/musicbrainz-library-view';
import { findAlbumMateTrackIds } from '@/lib/musicbrainz-work-queries';
import { getMusicBrainzWorkDetail, getMusicBrainzWorkParent } from '@/lib/musicbrainz-work-page';

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
  // Read the whole album behind each liked track, so the movements nobody
  // hearted are still on the card and can be played from it.
  const liked = new Set(likedTrackIds);
  return keepLikedHoldings(
    await readLibraryCards(await findAlbumMateTrackIds(likedTrackIds), liked, new Map(addedAt)),
    liked,
  );
}

/**
 * Everything a work page shows, in one request. Server actions from one page
 * run one after another, so asking for the recording and for its collection
 * separately made the page wait for both in turn.
 *
 * No liked set is sent: the page reads hearts off the live library, and a
 * whole library of track ids on every visit was upload time for nothing.
 */
export async function getMusicBrainzWorkPage(
  workMbid: string,
  recordingMbid: string | null,
): Promise<{ detail: WorkDetail | null; parent: WorkParent | null }> {
  const [detail, parent] = await Promise.all([
    getMusicBrainzWorkDetail(workMbid, recordingMbid),
    // The collection is a footnote to the page; failing to read it should
    // not cost the reader the recording.
    getMusicBrainzWorkParent(workMbid).catch((err) => {
      console.error('Failed to read work collection:', err);
      return null;
    }),
  ]);
  return { detail, parent };
}
