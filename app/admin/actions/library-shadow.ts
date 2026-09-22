'use server';

import { getLibraryWorks } from '@/app/actions/library';
import { loadMusicBrainzLibraryFacts } from '@/app/actions/library-musicbrainz';
import { projectMusicBrainzLibrary } from '@/lib/musicbrainz-library';
import { compareLibraryProjections, type ShadowComparison } from '@/lib/musicbrainz-shadow';
import { checkAuth } from './auth';

/**
 * Runs both readers over the same liked track IDs and returns where they
 * differ. Renders nothing, changes nothing, and stores nothing — in
 * particular it does not record which tracks were asked about, so running it
 * creates no user-to-track relation.
 *
 * The liked IDs come from the caller because that is where they live: the
 * client holds the current Spotify library, and the plan keeps it that way.
 */
export async function getLibraryShadowComparison(
  likedTrackIds: string[],
): Promise<ShadowComparison> {
  await checkAuth();
  const [legacyWorks, facts] = await Promise.all([
    getLibraryWorks(likedTrackIds),
    loadMusicBrainzLibraryFacts(likedTrackIds),
  ]);
  return compareLibraryProjections(legacyWorks, projectMusicBrainzLibrary(facts));
}
