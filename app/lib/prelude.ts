import type { MusicBrainzGapCode } from './musicbrainz-library';

/**
 * Shared vocabulary for the three editorial screens: library, recording
 * detail, catalogue. Pure helpers only, so both server actions and client
 * components can use them.
 */

/** Eras, in the order the design lists them. */
export const ERAS = [
  'Baroque',
  'Classical',
  'Romantic',
  'Impressionist',
  '20th C.',
  'Contemporary',
] as const;

export type Era = (typeof ERAS)[number];

/**
 * The design tags every composer with an era. We only store birth years, so
 * the era is derived from them — the boundaries reproduce the design's own
 * labelling (Bach Baroque, Beethoven Classical, Mahler Romantic, Debussy and
 * Ravel Impressionist, Shostakovich 20th C., Pärt and Glass Contemporary).
 */
export function eraFor(birthYear: number | null): Era | null {
  // Nearly half the composers we hold have no birth year. Guessing "Contemporary"
  // for all of them would file Suppé beside Glass, so say nothing instead.
  if (birthYear === null) return null;
  if (birthYear < 1710) return 'Baroque';
  if (birthYear < 1780) return 'Classical';
  if (birthYear <= 1860) return 'Romantic';
  if (birthYear < 1880) return 'Impressionist';
  if (birthYear < 1920) return '20th C.';
  return 'Contemporary';
}

/** "1685–1750", "1935–", or "" when we know neither date. */
export function lifespan(birthYear: number | null, deathYear: number | null): string {
  if (birthYear === null && deathYear === null) return '';
  if (birthYear === null) return `d. ${deathYear}`;
  return `${birthYear}–${deathYear ?? ''}`;
}

/**
 * A composer's surname, for the places the design shows a short name
 * ("Bach", "Pärt") next to the full one.
 */
export function surname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

/**
 * The short display name: forenames as initials, surname in full — "J. S.
 * Bach", "L. van Beethoven", "A. Pärt". Nobiliary particles stay lowercase.
 *
 * Applied to everyone rather than only where surnames collide, so the label
 * for a composer reads the same wherever it appears. It also keeps the four
 * Bachs in the catalogue apart, which a bare surname could not.
 */
export function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return fullName;
  const last = parts[parts.length - 1];
  const lead = parts
    .slice(0, -1)
    .map((word) => (word === word.toLowerCase() ? word : `${word[0].toUpperCase()}.`))
    .join(' ');
  return `${lead} ${last}`;
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

const ROMAN: [number, string][] = [
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

/** Movement numbers are set as roman numerals throughout the design. */
export function roman(n: number): string {
  if (n < 1) return String(n);
  let rest = n;
  let out = '';
  for (const [value, numeral] of ROMAN) {
    while (rest >= value) {
      out += numeral;
      rest -= value;
    }
  }
  return out;
}

/** "VIII." for the numeral column, or nothing when a part carries no numeral. */
export function numeralPrefix(numeral: string): string {
  return numeral ? `${numeral}.` : '';
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Album tints. The design colours the player bar and each card's wash from
 * the album art; we have no colour extraction in the pipeline, so a stable
 * hash picks from the prototype's own palette. Same album, same tint, always.
 */
const TINTS: [tint: string, ink: string][] = [
  ['#3a4a3a', '#f4ecd8'],
  ['#1e2438', '#e8dfc6'],
  ['#2d4a52', '#f0ead6'],
  ['#2a1f2e', '#e6d9b8'],
  ['#3a2018', '#eadbc0'],
  ['#6b7a7e', '#f5f0e1'],
  ['#2e2432', '#e9dcc4'],
  ['#3a3020', '#f2e7cc'],
  ['#2a3a2e', '#e8ddc3'],
  ['#2b2028', '#ecdeb8'],
  ['#2c2a20', '#efe3c2'],
  ['#1f3036', '#eee0bc'],
  ['#26303a', '#e7dcc0'],
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

export function tintFor(seed: string): { tint: string; ink: string } {
  const [tint, ink] = TINTS[Math.abs(hash(seed)) % TINTS.length];
  return { tint, ink };
}

/**
 * Pick the smallest Spotify image at least `minWidth` across — their arrays
 * lead with a 1000px original, which is wasteful for a 30px monogram.
 */
export function pickImage(
  images: { url: string; width: number; height: number }[] | null | undefined,
  minWidth: number,
): string | null {
  if (!images || images.length === 0) return null;
  const ascending = [...images].sort((a, b) => a.width - b.width);
  return (ascending.find((image) => image.width >= minWidth) ?? ascending[ascending.length - 1])
    .url;
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = (hex || '#222222').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** "BWV 1007", or null when the work carries no catalogue number. */
export function catalogLabel(
  system: string | null | undefined,
  number: string | null | undefined,
): string | null {
  if (!system || !number) return null;
  return `${system} ${number}`;
}

/* ---------------------------------------------------------------
   Shapes shared between the server actions and the screens
   --------------------------------------------------------------- */

export interface Movement {
  /** 1-based index in display order. */
  n: number;
  /** The part's own position in the work, which display order follows. */
  position: number;
  roman: string;
  name: string;
  /**
   * No MusicBrainz title. `name` is blank for a cached part without one, or
   * Spotify's raw track title for a track we have not matched at all.
   */
  unnamed: boolean;
  /**
   * The work has this part but the recording has no track for it. Rendered
   * greyed out, so a partial recording reads as partial instead of looking
   * like a short work.
   */
  missing: boolean;
  durationMs: number | null;
  duration: string | null;
  liked: boolean;
  trackId: string | null;
  uri: string | null;
}

/** What an unnamed movement's marker says is shown in place of a title. */
export function unnamedMovementNote(movement: Movement): string {
  return movement.name
    ? 'No MusicBrainz title — showing the Spotify track title'
    : 'No MusicBrainz title';
}

/** The movements a recording actually carries, in programme order. */
export function playable(movements: Movement[]): Movement[] {
  return movements.filter((m) => !m.missing && m.uri !== null);
}

/** URIs to queue when starting from one movement: it and everything after. */
export function queueFrom(movements: Movement[], from: Movement): string[] {
  return playable(movements)
    .filter((m) => m.position >= from.position)
    .map((m) => m.uri as string);
}

export interface LibraryWork {
  /** A work can be recorded more than once, so identity is work + recording. */
  id: string;
  /**
   * Opaque MusicBrainz identifiers, never numbers to do arithmetic on.
   * Screens compare them or put them in a URL.
   *
   * Null where there is no work to navigate to — something playing that we
   * cannot place. That used to be spelled -1, which reads like an id.
   */
  workId: string | null;
  recordingId: string | null;
  /** Null where the reader has no composer for the work, not "Unknown". */
  composer: string | null;
  composerFull: string | null;
  composerId: string | null;
  /** The composer's Spotify artist portrait, when we have one. */
  composerImage: string | null;
  era: Era | null;
  years: string;
  /** Null where the reader has no title for the work. The card says so. */
  title: string | null;
  nickname: string | null;
  catalog: string | null;
  year: number | null;
  performer: string | null;
  ensemble: string | null;
  album: string;
  /**
   * The Spotify album the chosen occurrence came from. A provider fact, and
   * the thing the card's colour is derived from — kept rather than recomputed
   * so a caller that needs to name the album has the id and not a title.
   */
  albumId: string | null;
  cover: string | null;
  tint: string;
  ink: string;
  movements: Movement[];
  /** No track in this recording has canonical work-part metadata yet. */
  unmatched: boolean;
  /**
   * What is missing from this card, named. Empty from the reader in
   * production, which has no vocabulary for a gap; the MusicBrainz reader
   * fills it so a card can show a hole instead of looking complete.
   */
  gaps: MusicBrainzGapCode[];
  /** When the user saved the most recent of these movements, ISO 8601. */
  addedAt: string | null;
}

/**
 * MusicBrainz titles a part with its collection in front. Repeating that on
 * every row of a list headed by the collection is noise.
 */
export function stripCollectionPrefix(title: string, parentTitle: string): string {
  const prefix = `${parentTitle}:`;
  if (!title.startsWith(prefix)) return title;
  return title.slice(prefix.length).trim() || title;
}
