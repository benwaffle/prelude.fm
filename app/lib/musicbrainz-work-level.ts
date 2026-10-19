// Collapsing a piece into its parent is the expensive, invisible mistake (seven Bach preludes
// become one), so the rules climb only on positive evidence; anything unsettled stays put and is
// reported.
import { roman } from './prelude';

export type WorkNode = {
  mbid: string;
  title: string;
  /** Movements are never typed. */
  type: string | null;
  parentMbid: string | null;
  parentTitle: string | null;
  parentType?: string | null;
  /** An opera, Mass or other whole of numbers further up than the parent. */
  wholeAbove?: boolean;
  hasChildren: boolean;
  orderingKey?: number | null;
};

export type WorkLevel = {
  mbid: string;
  /** So a report can explain itself and a wrong rule can be found. */
  reason: 'has-parts' | 'typed' | 'no-parent' | 'titled-as-part' | 'filed-in-whole' | 'unresolved';
  needsReview: boolean;
};

// Spellings MusicBrainz editors vary between a parent and its parts ("in e minor" / "in E minor",
// "E‐flat" / "E-flat").
function spelling(title: string): string {
  return title
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase();
}

function titledAsPartOf(node: WorkNode): boolean {
  if (!node.parentTitle) return false;
  const parentTitle = spelling(node.parentTitle);
  const title = node.title;
  for (let colon = title.indexOf(':'); colon !== -1; colon = title.indexOf(':', colon + 1)) {
    const head = spelling(title.slice(0, colon));
    // A parent may extend its parts' heading: "The Four Seasons Recomposed" / "The Four Seasons: Spring 1".
    if (parentTitle === head || parentTitle.startsWith(`${head} `)) return true;
  }
  return false;
}

// A roman numeral matching the part's position is a movement; collection pieces use "no. 5"
// instead.
function numberedAsPart(node: WorkNode): boolean {
  // "18 Pieces, op. 72" numbers its pieces the same way, and they are pieces.
  if (!node.parentTitle || /^\d/.test(node.parentTitle)) return false;
  if (!node.orderingKey || node.orderingKey < 1 || node.orderingKey > 89) return false;
  const lastColon = node.title.lastIndexOf(':');
  if (lastColon === -1) return false;
  const tail = node.title.slice(lastColon + 1).trim();
  const numeral = `${roman(node.orderingKey)}.`;
  return tail === numeral || tail.startsWith(`${numeral} `);
}

function withoutCatalogues(title: string): string {
  return title.replace(/, [A-Z]{1,4}\.? ?[A-Z]?\d[\w./–-]*(?=[:,]|$)/g, '');
}

// Only parents titled as a part qualify, so "Mazurkas, op. 33" never takes "Mazurkas, op. 33, no.
// 2".
function continuesPartTitle(node: WorkNode): boolean {
  if (!node.parentTitle?.includes(':')) return false;
  const parent = spelling(withoutCatalogues(node.parentTitle));
  const title = spelling(withoutCatalogues(node.title));
  return title.startsWith(`${parent}, `) || title.startsWith(`${parent} - `);
}

// An aria titled as part of an oratorio is a number of it, even though MusicBrainz types it "Aria".
const WHOLES_OF_NUMBERS = new Set([
  'Cantata',
  'Incidental music',
  'Mass',
  'Motet',
  'Opera',
  'Operetta',
  'Oratorio',
  'Passion',
  'Requiem',
  'Zarzuela',
]);

/** MusicBrainz types a sonata's movements "Sonata", so a shared type doesn't make a piece. */
function typedPartOf(node: WorkNode): boolean {
  // An untyped psalm setting's numbered arias ("Dixit Dominus, HWV 232: II. Aria …") are movements.
  if (node.type === 'Aria' && numberedAsPart(node)) return titledAsPartOf(node);
  if (!node.type || !node.parentType || node.type === 'Étude') return false;
  if (node.type !== node.parentType && !WHOLES_OF_NUMBERS.has(node.parentType)) return false;
  return titledAsPartOf(node) || continuesPartTitle(node);
}

export function isWholeOfNumbers(type: string | null | undefined): boolean {
  return WHOLES_OF_NUMBERS.has(type ?? '');
}

export function workLevelOf(node: WorkNode): WorkLevel {
  // Anything filed in an opera or Mass, or in one of its acts ("Il Bajazet, Atto I, Scena 1: Aria"
  // under "Atto I"), is a number of it, however it is titled or typed. A typed piece with its own
  // parts (a suite drawn from the opera) still decides for itself.
  const inWhole = node.wholeAbove || WHOLES_OF_NUMBERS.has(node.parentType ?? '');
  if (node.parentMbid && inWhole && !(node.type && node.hasChildren)) {
    return { mbid: node.parentMbid, reason: 'filed-in-whole', needsReview: false };
  }

  if (node.hasChildren) {
    // A numbered section ("III. Sequenz") is still a part; a prelude and fugue in a book of 24 is a
    // piece, so a parent's title alone is not enough.
    const sectionOf = node.parentMbid && (node.type ? typedPartOf(node) : numberedAsPart(node));
    return sectionOf
      ? { mbid: node.parentMbid!, reason: 'titled-as-part', needsReview: false }
      : { mbid: node.mbid, reason: 'has-parts', needsReview: false };
  }

  // MusicBrainz types works, not movements: this keeps 24 Chopin études from collapsing into "12
  // Études, Op. 10".
  if (node.type) {
    if (node.parentMbid && typedPartOf(node)) {
      return { mbid: node.parentMbid, reason: 'titled-as-part', needsReview: false };
    }
    return { mbid: node.mbid, reason: 'typed', needsReview: false };
  }

  if (!node.parentMbid) return { mbid: node.mbid, reason: 'no-parent', needsReview: false };

  if (titledAsPartOf(node) || numberedAsPart(node) || continuesPartTitle(node)) {
    return { mbid: node.parentMbid, reason: 'titled-as-part', needsReview: false };
  }

  // Could be a movement or a piece in a collection; those want opposite answers, so it stays put
  // and says so.
  return { mbid: node.mbid, reason: 'unresolved', needsReview: true };
}
