// Harmony may also merge other stores' data, so a difference from the landed release is the
// person's correction or Harmony's merge.

export type SeedArtist = {
  spotifyId: string | null;
  name: string;
  mbid?: string | null;
};

export type SeedTrack = {
  disc: number;
  position: number;
  title: string;
  durationMs: number;
  isrc: string | null;
  artists: SeedArtist[];
  recordingMbid?: string | null;
};

export type ReleaseSeed = {
  albumId: string;
  title: string;
  upc: string | null;
  // `library`: Spotify could not be read, so album artists are unknown and track artists unordered.
  source: 'spotify' | 'library';
  albumArtists: SeedArtist[];
  tracks: SeedTrack[];
  /** Absent on older checks. */
  releaseDate?: string | null;
  /** Absent on older checks. */
  label?: string | null;
};

export function orderedSeedTracks(seed: ReleaseSeed): SeedTrack[] {
  return [...seed.tracks].sort((a, b) => a.disc - b.disc || a.position - b.position);
}

/** Only to decide whether two strings name the same thing, never to display. */
export function looseName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\p{Pd}/gu, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleWords(value: string): string[] {
  return looseName(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'in',
  'de',
  'la',
  'le',
  'der',
  'die',
  'das',
]);

// `similar`: one title's words all appear in the other and make up most of it. A swapped word is
// `different`.
export function titleLikeness(a: string, b: string): 'same' | 'similar' | 'different' {
  const left = titleWords(a);
  const right = titleWords(b);
  if (left.length === 0 || right.length === 0) return 'different';
  if (left.join(' ') === right.join(' ')) return 'same';
  const content = (words: string[]) => new Set(words.filter((word) => !STOPWORDS.has(word)));
  const [smaller, larger] = [content(left), content(right)].sort((x, y) => x.size - y.size);
  if (smaller.size < 2) return 'different';
  const contained = [...smaller].every((word) => larger.has(word));
  return contained && smaller.size / larger.size >= 0.6 ? 'similar' : 'different';
}

export function isVariousArtists(name: string): boolean {
  return looseName(name) === 'various artists';
}

export function seedArtists(seed: ReleaseSeed): {
  artist: SeedArtist;
  tracks: number;
  onAlbum: boolean;
}[] {
  const byKey = new Map<string, { artist: SeedArtist; tracks: number; onAlbum: boolean }>();
  const keyOf = (artist: SeedArtist) => artist.spotifyId ?? `name:${looseName(artist.name)}`;
  for (const artist of seed.albumArtists) {
    if (isVariousArtists(artist.name)) continue;
    byKey.set(keyOf(artist), { artist, tracks: 0, onAlbum: true });
  }
  for (const track of seed.tracks) {
    for (const artist of track.artists) {
      const entry = byKey.get(keyOf(artist)) ?? { artist, tracks: 0, onAlbum: false };
      entry.tracks++;
      byKey.set(keyOf(artist), entry);
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      Number(b.onAlbum) - Number(a.onAlbum) ||
      b.tracks - a.tracks ||
      a.artist.name.localeCompare(b.artist.name),
  );
}
