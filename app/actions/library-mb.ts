'use server';

import type { WorkDetail } from '@/lib/library-types';
import { readLibraryCards } from '@/lib/musicbrainz-library-cards';
import { keepLikedHoldings, type MusicBrainzLibrary } from '@/lib/musicbrainz-library-view';
import { findAlbumMateTrackIds } from '@/lib/musicbrainz-work-queries';
import { getMusicBrainzWorkDetail } from '@/lib/musicbrainz-work-page';

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

// No liked set is sent; the page reads hearts off the live library.
export async function getMusicBrainzWorkPage(
  workMbid: string,
  recordingMbid: string | null,
): Promise<WorkDetail | null> {
  return getMusicBrainzWorkDetail(workMbid, recordingMbid);
}
