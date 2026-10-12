// An allowlist of roles, not a denylist: the cache holds roles like `balance` and `instrument
// technician`, and a denylist would promote the next unfamiliar one into the credit line.

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
  performers: string[];
  /** Kept, but not the credit line. */
  production: { name: string; role: string }[];
};

const SOLOIST_ROLES = new Set(['instrument', 'vocal']);
const ENSEMBLE_ROLES = new Set(['performing orchestra', 'orchestra', 'performing chorus', 'choir']);

// MusicBrainz credits a choir as `vocal` + `choir vocals`; read as a soloist it would push out the
// real soloist.
const CHORAL_INSTRUMENT = /\bchoir\b|\bchorus\b/i;
const CONDUCTOR_ROLES = new Set(['conductor', 'chorus master']);
const PERFORMER_ROLES = new Set(['performer']);

// Order is MusicBrainz's (principal first, usually). Duplicates collapse by artist: a soloist who
// also directs.
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

export function hasPerformingCredits(credits: PerformingCredits): boolean {
  return (
    credits.soloists.length > 0 ||
    credits.conductors.length > 0 ||
    credits.ensembles.length > 0 ||
    credits.performers.length > 0
  );
}

// Where MusicBrainz says nothing, both slots are null and the card says so rather than inventing a
// performer.
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
