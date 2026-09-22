/**
 * Reading what a person typed into the catalogue search.
 *
 * A listener looking for a particular piece types one of a few things: a
 * composer's name, a work's title, or — most usefully, because it is exact —
 * a catalogue reference. "BWV 1067", "K. 551", "Hob. I:82", "L 413".
 *
 * A catalogue reference deserves its own handling because it identifies one
 * work rather than narrowing a list, and because it is the only way to find a
 * piece whose title you cannot spell or whose title you know in another
 * language. It is also what makes importing alternate catalogues worth
 * anything: MusicBrainz gives us Chopin's B. and C. numbers, Scarlatti's
 * Longo and the Fanna numbers for Vivaldi, and none of them can be reached by
 * typing a title.
 */
import { normalizeCatalogNumber, normalizeCatalogSystem } from './classical-normalization';

export type CatalogueQuery =
  /** `BWV 1067` — a sigil and a number. */
  | { kind: 'reference'; system: string; number: string }
  /** `1067` — a number with no sigil; any catalogue may match. */
  | { kind: 'number'; number: string }
  /** Anything else: a name, a title, a nickname. */
  | { kind: 'text'; text: string };

/**
 * A sigil then a number: `BWV 1067`, `K. 551`, `Hob. I:82`, `op. 27 no. 2`.
 *
 * The number must start with a digit, or with a roman numeral that ends
 * where the number ends — `Hob. I:82`, `op. IX`. Accepting any word that
 * merely begins with a roman letter read "piano sonata" as the reference
 * "P. ianosonata", which matches nothing, so a perfectly ordinary title
 * search came back empty with no explanation.
 */
const REFERENCE = /^([A-Za-z]{1,6})\.?\s*([0-9].*|[IVXLCivxlc]+(?![A-Za-z]).*)$/;

/** A bare number, possibly with a suffix: `1067`, `1006a`, `I:82`. */
const BARE_NUMBER = /^[0-9][0-9A-Za-z/:.-]*$/;

export function parseCatalogueQuery(raw: string): CatalogueQuery {
  const query = raw.trim();
  if (!query) return { kind: 'text', text: '' };

  if (BARE_NUMBER.test(query)) {
    return { kind: 'number', number: normalizeCatalogNumber(query) };
  }

  const match = REFERENCE.exec(query);
  if (match) {
    const system = normalizeCatalogSystem(match[1]);
    const number = normalizeCatalogNumber(match[2]);
    // A sigil of one or two letters followed by a number is almost always a
    // catalogue reference; longer words are more likely the start of a title
    // ("Sonata 3"), so those stay text and match on the title instead.
    if (system.length <= 4 && number) return { kind: 'reference', system, number };
  }

  return { kind: 'text', text: query.toLocaleLowerCase() };
}
