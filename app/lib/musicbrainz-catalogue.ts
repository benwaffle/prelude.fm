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
 * Sigils for the catalogues MusicBrainz numbers without one.
 *
 * Most series put the sigil in the reference — "BWV 912" — and need nothing
 * here. A few number their works bare: the Köchel series calls Mozart's 41st
 * symphony "551" and nothing else, so the reference alone cannot say what
 * kind of number it is, and filing it under the series' full name leaves it
 * unfindable by the K number every listener knows it by.
 *
 * This is reference data rather than a guess — these are the standard
 * abbreviations — and matching is on a distinctive fragment so that
 * punctuation and spelling variants in the series name do not defeat it.
 */
const BARE_NUMBERED_SERIES: { contains: string; sigil: string }[] = [
  { contains: 'kochelverzeichnis', sigil: 'KV' },
  { contains: 'kirkpatrick', sigil: 'K' },
  { contains: 'longo', sigil: 'L' },
  { contains: 'cajkovskij', sigil: 'ČW' },
  { contains: 'biamonti', sigil: 'Bia' },
  { contains: 'hensel', sigil: 'H-U' },
];

/** The sigil a bare-numbered series is written with, if we know it. */
function sigilForSeries(seriesName: string): string | null {
  const normalized = normalizeCatalogSystem(seriesName);
  for (const entry of BARE_NUMBERED_SERIES) {
    if (normalized.includes(entry.contains)) return entry.sigil;
  }
  return null;
}

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
  // A reference with no sigil of its own takes the one its series is written
  // with, and falls back to the series name when we do not know it — a long
  // system is worse than a short one, but inventing a sigil is worse still.
  const system = match ? match[1] : (sigilForSeries(seriesName) ?? seriesName.trim());
  const number = match ? match[2].trim() : value;
  if (!system || !number) return null;

  return {
    system,
    number,
    normalizedSystem: normalizeCatalogSystem(system),
    normalizedNumber: normalizeCatalogNumber(number),
  };
}
