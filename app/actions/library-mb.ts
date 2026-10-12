'use server';

import type { WorkDetail, WorkParent } from '@/lib/library-types';
import { readLibraryCards } from '@/lib/musicbrainz-library-cards';
import { keepLikedHoldings, type MusicBrainzLibrary } from '@/lib/musicbrainz-library-view';
import { findAlbumMateTrackIds } from '@/lib/musicbrainz-work-queries';
import { getMusicBrainzWorkDetail, getMusicBrainzWorkParent } from '@/lib/musicbrainz-work-page';

/** Stores nothing: the liked IDs arrive from the caller and are not written down. */
export async function getMusicBrainzLibrary(
  likedTrackIds: string[],
  addedAt: Array<[string, string]> = [],
): Promise<MusicBrainzLibrary> {
  // Read the whole album behind each liked track, so unhearted movements are still on the card.
  const liked = new Set(likedTrackIds);
  return keepLikedHoldings(
    await readLibraryCards(await findAlbumMateTrackIds(likedTrackIds), liked, new Map(addedAt)),
    liked,
  );
}

// One request because server actions from a page run serially. No liked set is sent; the page reads
// hearts off the live library.
export async function getMusicBrainzWorkPage(
  workMbid: string,
  recordingMbid: string | null,
): Promise<{ detail: WorkDetail | null; parent: WorkParent | null }> {
  const [detail, parent] = await Promise.all([
    getMusicBrainzWorkDetail(workMbid, recordingMbid),
    // Failing to read the collection should not cost the reader the recording.
    getMusicBrainzWorkParent(workMbid).catch((err) => {
      console.error('Failed to read work collection:', err);
      return null;
    }),
  ]);
  return { detail, parent };
}
