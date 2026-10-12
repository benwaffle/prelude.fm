// Our own list of classical composers (Ben's call: a track is classical when its composer is on
// it). Restored from the composer table dropped on 2026-09-23, minus FILM_COMPOSERS. Keyed by
// Spotify artist ID, since Spotify credits are all we have for tracks MusicBrainz lacks.
import CLASSICAL_COMPOSERS from './classical-composers.json';

const NAMES: Record<string, string> = CLASSICAL_COMPOSERS;

export function listedComposerOf(spotifyArtistIds: string[]): string | null {
  const id = spotifyArtistIds.find((artistId) => artistId in NAMES);
  return id ? NAMES[id] : null;
}

export function classicalComposerReason(composer: string): string {
  return `Spotify credits ${composer}, on our list of classical composers`;
}
