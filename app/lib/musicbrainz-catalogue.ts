// MusicBrainz puts the whole reference in one attribute ("BWV 912"); we store sigil and number
// apart, as the parser does, or the two never meet in a search.
import { normalizeCatalogNumber, normalizeCatalogSystem } from './classical-normalization';

export type CatalogueReference = {
  system: string;
  number: string;
  normalizedSystem: string;
  normalizedNumber: string;
};

/** `BWV Anh. 113`'s number is `Anh. 113`. */
const SIGIL_THEN_NUMBER = /^([A-Za-z]+\.?)\s+(\S.*)$/;

const SIGIL_JOINED = /^([A-Za-z]+\.?)\s*(\d.*)$/;

// A few series number works bare (Köchel calls Jupiter "551"); these standard sigils make them
// findable by K number. Matched on a distinctive fragment so series-name spelling variants don't
// defeat it.
const BARE_NUMBERED_SERIES: { contains: string; sigil: string }[] = [
  { contains: 'kochelverzeichnis', sigil: 'KV' },
  { contains: 'kirkpatrick', sigil: 'K' },
  { contains: 'longo', sigil: 'L' },
  { contains: 'cajkovskij', sigil: 'ČW' },
  { contains: 'biamonti', sigil: 'Bia' },
  { contains: 'hensel', sigil: 'H-U' },
];

function sigilForSeries(seriesName: string): string | null {
  const normalized = normalizeCatalogSystem(seriesName);
  for (const entry of BARE_NUMBERED_SERIES) {
    if (normalized.includes(entry.contains)) return entry.sigil;
  }
  return null;
}

export function splitCatalogueReference(
  seriesName: string,
  reference: string,
): CatalogueReference | null {
  const value = reference.trim();
  if (!value) return null;

  const match = SIGIL_THEN_NUMBER.exec(value) ?? SIGIL_JOINED.exec(value);
  // Falls back to the series name when we don't know the sigil: a long system is better than an
  // invented one.
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
