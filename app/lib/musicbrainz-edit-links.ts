// No database imports: a wrong position writes a wrong ISRC upstream, so these must be testable
// alone.

export type IsrcGap = {
  spotifyTrackId: string;
  trackTitle: string;
  albumId: string;
  albumTitle: string;
  isrc: string;
  recordingMbid: string;
  recordingTitle: string;
  releaseMbid: string;
  barcode: string | null;
  /** Kept beside MusicBrainz's barcode rather than a boolean, so a person can check the match. */
  upc: string | null;
  medium: number;
  position: number;
  durationDeltaMs: number;
  matchedBy: string;
};

const EDIT_NOTE =
  'ISRCs from the Spotify release with the same barcode; durations match within 3s. https://prelude.fm';

// Positions are MusicBrainz's medium/track numbers, never this list's order: a wrong position
// attaches the ISRC to another recording.
export function magicIsrcLink(releaseMbid: string, gaps: IsrcGap[]): string {
  const parameters = new URLSearchParams({ musicbrainzid: releaseMbid });
  for (const gap of gaps) {
    parameters.set(`isrc${gap.medium}-${gap.position}`, gap.isrc);
  }
  parameters.set('edit-note', EDIT_NOTE);
  return `https://magicisrc.kepstin.ca/?${parameters.toString()}`;
}

export function recordingEditLink(recordingMbid: string): string {
  return `https://musicbrainz.org/recording/${recordingMbid}/edit`;
}

export function releaseEditLink(releaseMbid: string): string {
  return `https://musicbrainz.org/release/${releaseMbid}/edit`;
}

/** Work creation stays unseeded: the proposal is copy-ready evidence, not fact. */
export function workCreateLink(): string {
  return 'https://musicbrainz.org/work/create';
}

// Adding a release stays a human task: a duplicate release is expensive for others to merge away.
export function harmonyImportLink(spotifyAlbumId: string): string {
  const parameters = new URLSearchParams({
    url: `https://open.spotify.com/album/${spotifyAlbumId}`,
  });
  return `https://harmony.pulsewidth.org.uk/release?${parameters.toString()}`;
}
