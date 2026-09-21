/**
 * Reading a recording's credits the way a listener would.
 *
 * This replaces counting artist name strings and calling the two most
 * frequent ones performer and ensemble. That heuristic cannot tell a
 * conductor from an orchestra, cannot name an instrument, and silently merges
 * two artists who happen to share a name — and it is the headline of every
 * recording card.
 *
 * MusicBrainz states the roles outright, so the only judgement left here is
 * which roles a listener is looking for. That is an allowlist rather than a
 * denylist: the roles actually present in the cache include `balance`,
 * `instrument technician` and `creative direction`, and a denylist would
 * quietly promote the next unfamiliar one into the credit line.
 */

export type StoredCredit = {
  artistMbid: string;
  name: string;
  role: string;
  /** '' when the role carries no instrument. */
  instrument: string;
};

export type PerformingCredits = {
  soloists: { name: string; instrument: string | null }[];
  conductors: string[];
  ensembles: string[];
  /** Credited as a performer with nothing further said. */
  performers: string[];
  /** Producers, engineers, piano tuners: kept, but not the credit line. */
  production: { name: string; role: string }[];
};

const SOLOIST_ROLES = new Set(['instrument', 'vocal']);
const ENSEMBLE_ROLES = new Set(['performing orchestra', 'orchestra', 'performing chorus', 'choir']);

/**
 * A choir sings, so MusicBrainz credits it as a vocal — the Monteverdi Choir
 * arrives as `vocal` with the instrument `choir vocals`. Reading that as a
 * soloist puts a sixty-voice ensemble where the singer belongs and pushes the
 * actual soloist out of the credit line.
 */
const CHORAL_INSTRUMENT = /\bchoir\b|\bchorus\b/i;
const CONDUCTOR_ROLES = new Set(['conductor', 'chorus master']);
const PERFORMER_ROLES = new Set(['performer']);

/**
 * Sort a recording's credits into the parts a reader cares about.
 *
 * Order within each part is the order MusicBrainz gave, which for classical
 * releases tends to put the principal first. Duplicates are collapsed by
 * artist, because the same person can hold two roles on one recording — a
 * soloist who also directs — and naming them twice in one line reads as an
 * error.
 */
export function performingCredits(credits: StoredCredit[]): PerformingCredits {
  const result: PerformingCredits = {
    soloists: [],
    conductors: [],
    ensembles: [],
    performers: [],
    production: [],
  };

  const seen = { soloists: new Set<string>(), conductors: new Set<string>() };
  const ensembles = new Set<string>();
  const performers = new Set<string>();

  for (const credit of credits) {
    const isChoir = SOLOIST_ROLES.has(credit.role) && CHORAL_INSTRUMENT.test(credit.instrument);

    if (isChoir) {
      if (ensembles.has(credit.artistMbid)) continue;
      ensembles.add(credit.artistMbid);
      result.ensembles.push(credit.name);
    } else if (SOLOIST_ROLES.has(credit.role)) {
      if (seen.soloists.has(credit.artistMbid)) continue;
      seen.soloists.add(credit.artistMbid);
      result.soloists.push({ name: credit.name, instrument: credit.instrument || null });
    } else if (CONDUCTOR_ROLES.has(credit.role)) {
      if (seen.conductors.has(credit.artistMbid)) continue;
      seen.conductors.add(credit.artistMbid);
      result.conductors.push(credit.name);
    } else if (ENSEMBLE_ROLES.has(credit.role)) {
      if (ensembles.has(credit.artistMbid)) continue;
      ensembles.add(credit.artistMbid);
      result.ensembles.push(credit.name);
    } else if (PERFORMER_ROLES.has(credit.role)) {
      if (performers.has(credit.artistMbid)) continue;
      performers.add(credit.artistMbid);
      result.performers.push(credit.name);
    } else {
      result.production.push({ name: credit.name, role: credit.role });
    }
  }

  return result;
}

/**
 * MusicBrainz's special-purpose artists, which are not people.
 *
 * `[unknown]`, `[anonymous]`, `[traditional]`, `[no artist]` and the rest are
 * placeholders standing in for the absence of an artist, and the convention
 * is a name in square brackets. Printing one in a composer field would put a
 * value that reads like data where there is none — the app has its own way of
 * showing a gap, and this should reach it rather than dress itself up as a
 * name.
 */
export function isPlaceholderArtist(name: string | null | undefined): boolean {
  return /^\s*\[.+\]\s*$/.test(name ?? '');
}

/**
 * The name to print for an artist.
 *
 * Prefers what a release credited them as, because MusicBrainz files an
 * artist under their own script and the credited name is the Latin form the
 * label printed. Returns null for a placeholder, so the caller shows its own
 * blank state instead.
 */
export function displayName(artist: { name: string; creditedName?: string | null }): string | null {
  const name = artist.creditedName?.trim() || artist.name.trim();
  return isPlaceholderArtist(name) ? null : name;
}

/** Whether MusicBrainz said anything at all about who performed. */
export function hasPerformingCredits(credits: PerformingCredits): boolean {
  return (
    credits.soloists.length > 0 ||
    credits.conductors.length > 0 ||
    credits.ensembles.length > 0 ||
    credits.performers.length > 0
  );
}

/**
 * The two-slot credit the recording card shows.
 *
 * A concerto reads "soloist · orchestra"; a symphony has no soloist and reads
 * "conductor · orchestra"; a solo recital has only the pianist. Where
 * MusicBrainz says nothing, both slots are null and the card says so rather
 * than inventing a performer, which is the whole reason for replacing the
 * frequency count.
 */
export function creditLine(credits: PerformingCredits): {
  performer: string | null;
  ensemble: string | null;
} {
  const performer =
    credits.soloists[0]?.name ??
    credits.conductors[0] ??
    credits.performers[0] ??
    credits.ensembles[0] ??
    null;

  const ensemble =
    credits.ensembles.find((name) => name !== performer) ??
    credits.conductors.find((name) => name !== performer) ??
    credits.soloists.map((soloist) => soloist.name).find((name) => name !== performer) ??
    null;

  return { performer, ensemble };
}
