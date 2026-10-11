import type { AdminPage } from './admin-url';

/** The name each admin page goes by, on the home page and in its own header. */
export const PAGE_TITLE: Record<AdminPage, string> = {
  missing: 'Albums MusicBrainz has no release for',
  misaligned: 'Tracklists that do not line up',
  work: 'Recordings not linked to a work',
  contested: 'One ISRC on several recordings',
  isrc: 'Recordings missing ISRCs',
  barcodes: 'Releases with no barcode',
  streaming: 'Releases with no Spotify link',
  submitted: 'Sent to MusicBrainz, not there yet',
  albums: 'Albums in the library',
  corrections: 'Releases added through Harmony: what was corrected',
  'refresh-work': 'Refresh a work from MusicBrainz',
  checks: 'Cache checks and deployment',
};
