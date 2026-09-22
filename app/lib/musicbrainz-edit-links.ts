/**
 * Prefilled links to the places an edit is made.
 *
 * Until `prelude_fm_bot` is approved — and permanently, for the classes a bot
 * must never own — a contribution is a person clicking a link. These builders
 * are what make that a confirmation rather than a retyping exercise: the
 * evidence we already hold arrives in the form.
 *
 * Deliberately free of any database import, because getting a position wrong
 * here writes a wrong ISRC into somebody else's database and these functions
 * must be testable on their own.
 */

export type IsrcGap = {
  spotifyTrackId: string;
  trackTitle: string;
  albumId: string;
  albumTitle: string;
  isrc: string;
  recordingMbid: string;
  recordingTitle: string;
  releaseMbid: string;
  /** The barcode MusicBrainz holds for the release. */
  barcode: string | null;
  /**
   * The barcode Spotify reports for the album.
   *
   * Kept beside MusicBrainz's rather than collapsed into a boolean: the query
   * already requires them to match, so a "yes" column would only restate its
   * own precondition. The pair on screen is what lets a person check it.
   */
  upc: string | null;
  /** Where the recording sits on the release, which is how MagicISRC addresses it. */
  medium: number;
  position: number;
  durationDeltaMs: number;
  matchedBy: string;
};

const EDIT_NOTE =
  'ISRCs from the Spotify release with the same barcode; durations match within 3s. https://prelude.fm';

/**
 * A MagicISRC link that arrives with every missing ISRC already filled in.
 *
 * Positions are the ones MusicBrainz holds, not our own ordering. Sending an
 * ISRC to the wrong position attaches it to a different recording, which is
 * precisely the error these submissions exist to correct, so the key is built
 * from the release's medium and track number and never from the order of this
 * list.
 */
export function magicIsrcLink(releaseMbid: string, gaps: IsrcGap[]): string {
  const parameters = new URLSearchParams({ musicbrainzid: releaseMbid });
  for (const gap of gaps) {
    parameters.set(`isrc${gap.medium}-${gap.position}`, gap.isrc);
  }
  parameters.set('edit-note', EDIT_NOTE);
  return `https://magicisrc.kepstin.ca/?${parameters.toString()}`;
}

/** The recording's page, where a work relationship is added by hand. */
export function recordingEditLink(recordingMbid: string): string {
  return `https://musicbrainz.org/recording/${recordingMbid}/edit`;
}

/** A release's page, for a barcode or a streaming link. */
export function releaseEditLink(releaseMbid: string): string {
  return `https://musicbrainz.org/release/${releaseMbid}/edit`;
}

/** Work creation stays unseeded: the proposal is copy-ready evidence, not fact. */
export function workCreateLink(): string {
  return 'https://musicbrainz.org/work/create';
}

/**
 * Harmony, seeded from the Spotify album, for a release MusicBrainz lacks.
 *
 * Adding a release stays a human class permanently: a duplicate release is
 * expensive for other people to merge away, and that cost is not ours to
 * impose.
 */
export function harmonyImportLink(spotifyAlbumId: string): string {
  const parameters = new URLSearchParams({
    url: `https://open.spotify.com/album/${spotifyAlbumId}`,
  });
  return `https://harmony.pulsewidth.org.uk/release?${parameters.toString()}`;
}
