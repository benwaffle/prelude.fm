'use server';

import { loadMusicBrainzLibraryFacts } from './library-musicbrainz';
import { projectMusicBrainzLibrary } from '@/lib/musicbrainz-library';
import { musicBrainzLibraryView, type MusicBrainzLibrary } from '@/lib/musicbrainz-library-view';

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
