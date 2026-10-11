import { projectMusicBrainzLibrary } from './musicbrainz-library';
import { loadMusicBrainzLibraryFacts } from './musicbrainz-library-read';
import { musicBrainzLibraryView, type MusicBrainzLibrary } from './musicbrainz-library-view';

/**
 * These tracks as library cards: read the facts, project them, draw the
 * cards. Every screen that shows cards — the library, a work page, the
 * catalogue's recordings — goes through here.
 */
export async function readLibraryCards(
  spotifyTrackIds: string[],
  likedTrackIds: Set<string>,
  addedAtByTrackId?: Map<string, string>,
): Promise<MusicBrainzLibrary> {
  return musicBrainzLibraryView(
    projectMusicBrainzLibrary(await loadMusicBrainzLibraryFacts(spotifyTrackIds)),
    likedTrackIds,
    addedAtByTrackId,
  );
}
