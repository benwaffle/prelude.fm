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
  hasChildren: boolean;
  orderingKey?: number | null;
};

export type WorkLevel = {
  mbid: string;
  /** So a report can explain itself and a wrong rule can be found. */
  reason: 'has-parts' | 'typed' | 'no-parent' | 'titled-as-part' | 'unresolved';
  needsReview: boolean;
};

function shortenings(title: string, drops: (segment: string) => boolean): string[] {
  const stages = [title];
  for (;;) {
    const current = stages[stages.length - 1];
    const cut = current.lastIndexOf(', ');
    if (cut <= 0 || !drops(current.slice(cut + 2))) return stages;
    stages.push(current.slice(0, cut));
  }
}

/** Any segment with a number and no colon ("W. C12", "op. 6 no. 6"). */
const parentTrailer = (segment: string) => /\d/.test(segment) && !segment.includes(':');

/** Never a piece number: "no. 5" tells one piece in a collection from the next. */
const childTrailer = (segment: string) => /^[A-Z]{1,4}\.? ?[A-Z]?\d[\w./–-]*$/.test(segment);

// Spellings MusicBrainz editors vary between a parent and its parts ("in e minor" / "in E minor",
// "E‐flat" / "E-flat").
function spelling(title: string): string {
  return title
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase();
}

/** Either side may carry a catalogue reference the other leaves out. */
function titledAsPartOf(node: WorkNode): boolean {
  if (!node.parentTitle) return false;
  const parentTitle = spelling(node.parentTitle);
  // Only one side may lose a reference: RV 522 is not a movement of RV 523.
  const parentStages = shortenings(node.parentTitle, parentTrailer).map(spelling);
  const title = node.title;
  for (let colon = title.indexOf(':'); colon !== -1; colon = title.indexOf(':', colon + 1)) {
    const head = title.slice(0, colon);
    if (parentStages.includes(spelling(head))) return true;
    // A parent may extend its parts' heading: "The Four Seasons Recomposed" / "The Four Seasons: Spring 1".
    if (parentTitle.startsWith(`${spelling(head)} `)) return true;
    if (shortenings(head, childTrailer).some((stage) => spelling(stage) === parentTitle)) {
      return true;
    }
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
  if (!node.type || !node.parentType || node.type === 'Étude') return false;
  if (node.type !== node.parentType && !WHOLES_OF_NUMBERS.has(node.parentType)) return false;
  return titledAsPartOf(node) || continuesPartTitle(node);
}

export function workLevelOf(node: WorkNode): WorkLevel {
  if (node.hasChildren) {
    // A section of a Mass or opera ("III. Sequenz", "Act II") is still a part of it; a prelude and
    // fugue in a book of 24 is a piece, so a parent's title alone is not enough.
    const sectionOf =
      node.parentMbid &&
      (node.type
        ? typedPartOf(node)
        : numberedAsPart(node) ||
          (WHOLES_OF_NUMBERS.has(node.parentType ?? '') && titledAsPartOf(node)));
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
