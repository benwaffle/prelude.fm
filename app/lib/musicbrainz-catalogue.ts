/**
 * Reading a catalogue reference out of a MusicBrainz series relationship.
 *
 * MusicBrainz names the series and then puts the whole printed reference in
 * one attribute: series "Bach-Werke-Verzeichnis", number "BWV 912". We store
 * the sigil and the number apart, because that is how a reader writes it and
 * how the parser records it — "BWV" and "912".
 *
 * Getting this wrong is not cosmetic. Storing the series name as the system
 * leaves the imported reference under `bach-werke-verzeichnis`/`bwv912` while
 * every parser-derived row sits under `bwv`/`912`, so the two never meet and
 * a search for BWV 912 misses the work that MusicBrainz just told us about.
 */
import { normalizeCatalogNumber, normalizeCatalogSystem } from './classical-normalization';

export type CatalogueReference = {
  system: string;
  number: string;
  normalizedSystem: string;
  normalizedNumber: string;
};

/**
 * A leading sigil then the number: `BWV 912`, `Hob. I:82`, `op. 19`,
 * `S. 516a`, and `BWV Anh. 113`, whose number is `Anh. 113`.
 */
const SIGIL_THEN_NUMBER = /^([A-Za-z]+\.?)\s+(\S.*)$/;

/** The same without the space: `BWV912`. */
const SIGIL_JOINED = /^([A-Za-z]+\.?)\s*(\d.*)$/;

/**
 * Split a MusicBrainz catalogue reference into a system and a number.
 *
 * When the reference carries no sigil of its own — a series whose numbers are
 * bare, like `12` — the series name is the system, because inventing a sigil
 * would be worse than a long one.
 */
export function splitCatalogueReference(
  seriesName: string,
  reference: string,
): CatalogueReference | null {
  const value = reference.trim();
  if (!value) return null;

  const match = SIGIL_THEN_NUMBER.exec(value) ?? SIGIL_JOINED.exec(value);
  const system = match ? match[1] : seriesName.trim();
  const number = match ? match[2].trim() : value;
  if (!system || !number) return null;

  return {
    system,
    number,
    normalizedSystem: normalizeCatalogSystem(system),
    normalizedNumber: normalizeCatalogNumber(number),
  };
}
