import { projectMusicBrainzLibrary } from './musicbrainz-library';
import { loadMusicBrainzLibraryFacts } from './musicbrainz-library-read';
import { musicBrainzLibraryView, type MusicBrainzLibrary } from './musicbrainz-library-view';

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
