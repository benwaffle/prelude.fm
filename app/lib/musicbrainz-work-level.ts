/**
 * Which node of a MusicBrainz work tree is "the work" a reader sees.
 *
 * MusicBrainz's tree is deeper than the thing a listener calls a piece. A
 * track of "Concerto for 2 Violins in A minor, RV 523: I. Allegro molto"
 * should appear under the concerto, not under the movement — but a track of
 * "Mazurka no. 23 in D major, op. 33 no. 2" should appear under *itself*,
 * not under "Mazurkas, op. 33", even though both are childless nodes with a
 * parent.
 *
 * Getting that wrong in the collapsing direction is the expensive mistake. It
 * is what turns seven distinct Bach preludes into one work, and the damage is
 * invisible afterwards because the merged thing still looks like a plausible
 * piece. So the rules below only climb to the parent on positive evidence,
 * and anything they cannot settle stays where it is and is reported.
 *
 * Measured over the cache these were written against: 843 untyped childless
 * works have a parent, and 695 of them are titled with the parent's title as
 * a prefix. The remaining 148 are mostly genuine collections — Mazurkas,
 * Waltzes, Scarlatti's Essercizi — with a minority of real movements whose
 * parent is titled slightly differently. Leaving all 148 alone keeps the
 * collections right and costs a handful of movements their grouping, which
 * is the cheaper error of the two.
 */

export type WorkNode = {
  mbid: string;
  title: string;
  /** MusicBrainz work type. Movements are never typed. */
  type: string | null;
  parentMbid: string | null;
  parentTitle: string | null;
  /** The parent's MusicBrainz work type, when it has one. */
  parentType?: string | null;
  hasChildren: boolean;
  /** This work's position among its parent's parts, when it has one. */
  orderingKey?: number | null;
};

export type WorkLevel = {
  /** The work to show. */
  mbid: string;
  /** Why, so a report can explain itself and a wrong rule can be found. */
  reason: 'has-parts' | 'typed' | 'no-parent' | 'titled-as-part' | 'unresolved';
  /** True when the rules could not settle it and it was left where it is. */
  needsReview: boolean;
};

/**
 * A title and each shortening of it made by dropping one more trailing
 * comma-separated segment that `drops` accepts.
 */
function shortenings(title: string, drops: (segment: string) => boolean): string[] {
  const stages = [title];
  for (;;) {
    const current = stages[stages.length - 1];
    const cut = current.lastIndexOf(', ');
    if (cut <= 0 || !drops(current.slice(cut + 2))) return stages;
    stages.push(current.slice(0, cut));
  }
}

/**
 * What a parent's title may trail that its movements leave out: any segment
 * with a number and no colon ("W. C12", "op. 6 no. 6").
 */
const parentTrailer = (segment: string) => /\d/.test(segment) && !segment.includes(':');

/**
 * What a movement's title may trail that its parent leaves out: a catalogue
 * sigil and number only ("ZWV 62", "K. 475"). Never a piece number — "no. 5"
 * or "op. 19 no. 3" is what tells one piece in a collection from the next.
 */
const childTrailer = (segment: string) => /^[A-Z]{1,4}\.? ?[A-Z]?\d[\w./–-]*$/.test(segment);

/**
 * Case, dash and quote spellings MusicBrainz editors vary between a parent
 * and its parts ("in e minor" / "in E minor", "E‐flat" / "E-flat").
 */
function spelling(title: string): string {
  return title
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase();
}

/**
 * MusicBrainz titles a movement with its parent's title and a colon. Either
 * side may carry a catalogue reference the other leaves out ("Sinfonia in G
 * minor, op. 6 no. 6, W. C12" over "Sinfonia in G minor, op. 6 no. 6: I.
 * Allegro"; "Gesù al Calvario" over "Gesù al Calvario, ZWV 62: Aria: …").
 */
function titledAsPartOf(node: WorkNode): boolean {
  if (!node.parentTitle) return false;
  const parentTitle = spelling(node.parentTitle);
  // Only one side may lose a reference. When both do, they may have carried
  // different ones — RV 522 is not a movement of RV 523.
  const parentStages = shortenings(node.parentTitle, parentTrailer).map(spelling);
  const title = node.title;
  for (let colon = title.indexOf(':'); colon !== -1; colon = title.indexOf(':', colon + 1)) {
    const head = title.slice(0, colon);
    if (parentStages.includes(spelling(head))) return true;
    if (shortenings(head, childTrailer).some((stage) => spelling(stage) === parentTitle)) {
      return true;
    }
  }
  return false;
}

function toRoman(value: number): string {
  const numerals: Array<[number, string]> = [
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let rest = value;
  let out = '';
  for (const [amount, numeral] of numerals) {
    while (rest >= amount) {
      out += numeral;
      rest -= amount;
    }
  }
  return out;
}

/**
 * MusicBrainz numbers a movement in its title the way it orders it among the
 * parent's parts: the fifth part ends "…: V. Allegro". A piece in a
 * collection is titled by its own number ("no. 5", "op. 33 no. 2") instead,
 * so a roman numeral that matches the part's position is a movement however
 * the rest of the title is spelled.
 */
function numberedAsPart(node: WorkNode): boolean {
  // "18 Pieces, op. 72" numbers its pieces the same way, and they are pieces.
  if (!node.parentTitle || /^\d/.test(node.parentTitle)) return false;
  if (!node.orderingKey || node.orderingKey < 1 || node.orderingKey > 89) return false;
  const lastColon = node.title.lastIndexOf(':');
  if (lastColon === -1) return false;
  const tail = node.title.slice(lastColon + 1).trim();
  const numeral = `${toRoman(node.orderingKey)}.`;
  return tail === numeral || tail.startsWith(`${numeral} `);
}

/** A title without the catalogue references in it ("…, ZWV 21: Sanctus" → "…: Sanctus"). */
function withoutCatalogues(title: string): string {
  return title.replace(/, [A-Z]{1,4}\.? ?[A-Z]?\d[\w./–-]*(?=[:,]|$)/g, '');
}

/**
 * A number filed under an act or section of a larger work continues that
 * section's title: "Messiah, HWV 56: Part II, no. 28. Chorus …" under
 * "Messiah, HWV 56: Part II", or "Missa …: Sanctus - Benedictus" under
 * "Missa …, ZWV 21: Sanctus". Only parents that are themselves titled as a
 * part qualify, so "Mazurkas, op. 33" never takes "Mazurkas, op. 33, no. 2".
 */
function continuesPartTitle(node: WorkNode): boolean {
  if (!node.parentTitle?.includes(':')) return false;
  const parent = spelling(withoutCatalogues(node.parentTitle));
  const title = spelling(withoutCatalogues(node.title));
  return title.startsWith(`${parent}, `) || title.startsWith(`${parent} - `);
}

/**
 * Wholes whose parts are numbers in them rather than pieces collected
 * together: an aria titled as part of an oratorio is a number of that
 * oratorio, even though MusicBrainz types it "Aria".
 */
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

/**
 * A typed work still belongs to its parent when it is titled as part of it
 * and either shares the parent's type (MusicBrainz types a sonata's
 * movements "Sonata") or the parent is a whole made of numbers.
 */
function typedPartOf(node: WorkNode): boolean {
  if (!node.type || !node.parentType || node.type === 'Étude') return false;
  if (node.type !== node.parentType && !WHOLES_OF_NUMBERS.has(node.parentType)) return false;
  return titledAsPartOf(node) || continuesPartTitle(node);
}

export function workLevelOf(node: WorkNode): WorkLevel {
  // A work with parts is the thing those parts belong to.
  if (node.hasChildren) return { mbid: node.mbid, reason: 'has-parts', needsReview: false };

  // MusicBrainz types works, not movements. An Étude, a Sonata or an Aria is
  // a piece in its own right however deeply it is filed — this is what keeps
  // twenty-four Chopin études from collapsing into "12 Études, Op. 10".
  // The exception is a typed work titled as a number of its parent, above.
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

  // A childless, untyped work whose title does not name its parent. It might
  // be a movement whose parent is titled differently, or a piece inside a
  // collection. Those want opposite answers and nothing here distinguishes
  // them, so it stays put and says so.
  return { mbid: node.mbid, reason: 'unresolved', needsReview: true };
}
