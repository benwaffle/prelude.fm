import { normalizeCatalogNumber, normalizeCatalogSystem } from './classical-normalization';

export type CatalogueQuery =
  | { kind: 'reference'; system: string; number: string }
  | { kind: 'number'; number: string }
  | { kind: 'text'; text: string };

// The number must start with a digit or a whole roman numeral; otherwise "piano sonata" parses as
// "P. ianosonata".
const REFERENCE = /^([A-Za-z]{1,6})\.?\s*([0-9].*|[IVXLCivxlc]+(?![A-Za-z]).*)$/;

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
    // Short sigils with a number are almost always references; longer words ("Sonata 3") stay text.
    if (system.length <= 4 && number) return { kind: 'reference', system, number };
  }

  return { kind: 'text', text: query.toLocaleLowerCase() };
}
