import type { MusicBrainzGapCode } from './musicbrainz-library';

/** Pure helpers only, so both server actions and client components can use them. */

export const ERAS = [
  'Baroque',
  'Classical',
  'Romantic',
  'Impressionist',
  '20th C.',
  'Contemporary',
] as const;

export type Era = (typeof ERAS)[number];

/** Derived from birth years; boundaries reproduce the design's labelling. */
export function eraFor(birthYear: number | null): Era | null {
  // Nearly half the composers have no birth year; guessing an era would file Suppé beside Glass, so
  // say nothing.
  if (birthYear === null) return null;
  if (birthYear < 1710) return 'Baroque';
  if (birthYear < 1780) return 'Classical';
  if (birthYear <= 1860) return 'Romantic';
  if (birthYear < 1880) return 'Impressionist';
  if (birthYear < 1920) return '20th C.';
  return 'Contemporary';
}

export function lifespan(birthYear: number | null, deathYear: number | null): string {
  if (birthYear === null && deathYear === null) return '';
  if (birthYear === null) return `d. ${deathYear}`;
  return `${birthYear}–${deathYear ?? ''}`;
}

export function surname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || fullName;
}

// Applied to everyone, so a composer reads the same everywhere; it also keeps the four Bachs apart.
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

/** The smallest that still fills a portrait at twice its size, or the largest when none does. */
export function portraitOf(
  images: { url: string; width: number | null }[] | null | undefined,
): string | null {
  if (!images?.length) return null;
  const bySize = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (bySize.find((image) => (image.width ?? 0) >= 240) ?? bySize.at(-1)!).url;
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

/** No colour extraction in the pipeline, so a stable hash picks from the prototype's palette. */
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

export function hexToRgba(hex: string, alpha: number): string {
  const h = (hex || '#222222').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface Movement {
  n: number;
  position: number;
  roman: string;
  name: string;
  // `name` is blank for a cached part without one, or Spotify's raw title for an unmatched track.
  unnamed: boolean;
  /** The section a sub-part sits in ("III. Sequenz" for "a. Dies irae"), so a page can nest it. */
  section?: string | null;
  // Rendered greyed out, so a partial recording reads as partial instead of looking like a short
  // work.
  missing: boolean;
  durationMs: number | null;
  duration: string | null;
  liked: boolean;
  trackId: string | null;
  uri: string | null;
}

export function unnamedMovementNote(movement: Pick<Movement, 'name'>): string {
  return movement.name
    ? 'No MusicBrainz title — showing the Spotify track title'
    : 'No MusicBrainz title';
}

export type PlayableMovement = Movement & { missing: false; trackId: string; uri: string };

function isPlayable(movement: Movement): movement is PlayableMovement {
  return !movement.missing && movement.uri !== null && movement.trackId !== null;
}

export function playable(movements: Movement[]): PlayableMovement[] {
  return movements.filter(isPlayable);
}

export function queueFrom(movements: Movement[], from: Movement): string[] {
  return playable(movements)
    .filter((m) => m.position >= from.position)
    .map((m) => m.uri);
}

/** The live liked set runs ahead of any server snapshot. */
export function withLiveLikes(movements: Movement[], likedTrackIds: Set<string>): Movement[] {
  return movements.map((m) => ({
    ...m,
    liked: m.trackId !== null && likedTrackIds.has(m.trackId),
  }));
}

export interface LibraryWork {
  /** A work can be recorded more than once, so identity is work + recording. */
  id: string;
  /** Opaque MusicBrainz identifiers. */
  workId: string;
  recordingId: string;
  /** Null where the reader has no composer for the work, not "Unknown". */
  composer: string | null;
  composerFull: string | null;
  composerId: string | null;
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
  albumId: string | null;
  cover: string | null;
  tint: string;
  ink: string;
  movements: Movement[];
  unmatched: boolean;
  /** Named so a card can show a hole instead of looking complete. */
  gaps: MusicBrainzGapCode[];
  // The weakest confidence of any track filed under this work by our own match rather than
  // MusicBrainz.
  ownLink: 'high' | 'medium' | 'low' | null;
  addedAt: string | null;
}

// MusicBrainz titles a part with its collection in front; repeating it under the collection heading
// is noise.
export function stripCollectionPrefix(title: string, parentTitle: string): string {
  // The collection's title may also extend its parts' heading, or case it differently: "The Four
  // Seasons Recomposed", "Children’s Corner, L. 113, CD 119".
  const head = title.slice(0, Math.max(title.indexOf(':'), 0)).toLowerCase();
  const parent = parentTitle.toLowerCase();
  const prefix = title.startsWith(`${parentTitle}:`)
    ? `${parentTitle}:`
    : head && (parent === head || parent.startsWith(`${head} `) || parent.startsWith(`${head},`))
      ? `${head}:`
      : null;
  if (!prefix) return title;
  return title.slice(prefix.length).trim() || title;
}

export function workHref(work: Pick<LibraryWork, 'workId' | 'recordingId'>): string {
  return `/work/${work.workId}?rec=${work.recordingId}`;
}

export function workByline(work: Pick<LibraryWork, 'composerFull' | 'performer'>): string | null {
  return [work.composerFull, work.performer].filter(Boolean).join(' · ') || null;
}

export interface QueueEntry {
  id: string;
  uris: string[];
  title: string;
  subtitle: string | null;
  cover: string | null;
}

// A work MusicBrainz leaves untitled goes by its album, which is real, rather than a made-up name.
export function queueEntryFor(work: LibraryWork): Omit<QueueEntry, 'id'> {
  const title = work.title
    ? `${work.title}${work.nickname ? ` “${work.nickname}”` : ''}`
    : work.album;
  return {
    uris: playable(work.movements).map((m) => m.uri),
    title,
    subtitle: workByline(work),
    cover: work.cover,
  };
}

export function programmeMovementName(
  title: string,
  workTitle: string | null,
  roman: string,
): string {
  const name = workTitle ? stripCollectionPrefix(title, workTitle) : title;
  const numeral = `${roman}.`;
  if (
    roman &&
    (name === numeral || (name.startsWith(numeral) && /^\s/.test(name.slice(numeral.length))))
  ) {
    return name.slice(numeral.length).trimStart();
  }
  return name;
}
