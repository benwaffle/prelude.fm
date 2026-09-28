/**
 * What Harmony would seed a MusicBrainz release with, read from Spotify.
 *
 * Harmony builds the release editor form from the Spotify album: its title,
 * its artists, and each track's title, artists, position and length. This is
 * that same album, kept so the pre-checks can reason about it and so what
 * landed on MusicBrainz can be compared with it afterwards.
 *
 * Harmony may also merge in what other stores (Deezer, iTunes, …) say about
 * the same barcode. Those are not read here, so a difference between this
 * seed and the landed release is either the person's correction or
 * Harmony's own merge — the comparison cannot tell which.
 */

export type SeedArtist = {
  spotifyId: string | null;
  name: string;
  /** Set only on a baseline we seeded ourselves, where the artist was credited by MBID. */
  mbid?: string | null;
};

export type SeedTrack = {
  disc: number;
  position: number;
  title: string;
  durationMs: number;
  isrc: string | null;
  artists: SeedArtist[];
  /** Set only on a baseline we seeded ourselves: the existing recording we pre-filled. */
  recordingMbid?: string | null;
};

export type ReleaseSeed = {
  albumId: string;
  title: string;
  upc: string | null;
  /**
   * `spotify`: read live from the Spotify API, as Harmony would.
   * `library`: Spotify could not be read, so this is our stored copy — album
   * artists are unknown and track artists are in no particular order.
   */
  source: 'spotify' | 'library';
  albumArtists: SeedArtist[];
  tracks: SeedTrack[];
  /** Spotify's release date as given ('YYYY', 'YYYY-MM' or 'YYYY-MM-DD'); absent on older checks. */
  releaseDate?: string | null;
  /** Spotify's label name; absent on older checks. */
  label?: string | null;
};

/** Tracks in disc-then-position order. */
export function orderedSeedTracks(seed: ReleaseSeed): SeedTrack[] {
  return [...seed.tracks].sort((a, b) => a.disc - b.disc || a.position - b.position);
}

/**
 * Names compared loosely: case, accents and spacing do not count. Used only
 * to decide whether two strings name the same thing, never to display.
 */
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

/** Title words, for "is this search hit the same album" comparisons. */
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

/**
 * How alike two album titles are: `same` when their words are identical;
 * `similar` when one title's words all appear in the other and make up most
 * of it — an edition that adds "Complete" or a catalogue range. Titles that
 * swap a word ("Essential Allegros" / "Essential Adagios") are `different`.
 */
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

/** Spotify's placeholder for a compilation's album artist. */
export function isVariousArtists(name: string): boolean {
  return looseName(name) === 'various artists';
}

/** Distinct artists across the album and its tracks, most-credited first. */
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
