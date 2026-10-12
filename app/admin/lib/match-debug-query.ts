import { findMbid } from '@/lib/musicbrainz-manual-submissions';

// What a pasted string names. Links and bare IDs are read first so a title search never has to
// guess at one.
export type MatchDebugQuery =
  | { kind: 'spotify'; id: string }
  | { kind: 'mbid'; mbid: string }
  | { kind: 'isrc'; isrc: string }
  | { kind: 'barcode'; digits: string }
  | { kind: 'text'; text: string };

const SPOTIFY_LINK = /open\.spotify\.com\/(?:intl-[a-z]+\/)?(?:track|album)\/([0-9A-Za-z]{22})/;
const SPOTIFY_URI = /^spotify:(?:track|album):([0-9A-Za-z]{22})$/;
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;
const ISRC = /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i;
const BARCODE = /^\d{8,14}$/;

export function parseMatchDebugQuery(input: string): MatchDebugQuery | null {
  const text = input.trim();
  if (!text) return null;
  // A bare ID needs a digit, so a long one-word title still searches as text.
  const spotify =
    SPOTIFY_LINK.exec(text)?.[1] ??
    SPOTIFY_URI.exec(text)?.[1] ??
    (SPOTIFY_ID.test(text) && /\d/.test(text) ? text : null);
  if (spotify) return { kind: 'spotify', id: spotify };
  const mbid = findMbid(text);
  if (mbid) return { kind: 'mbid', mbid };
  if (BARCODE.test(text)) return { kind: 'barcode', digits: text };
  if (ISRC.test(text)) return { kind: 'isrc', isrc: text.replaceAll('-', '').toUpperCase() };
  return { kind: 'text', text };
}
