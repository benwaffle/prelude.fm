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

/** MusicBrainz titles a movement with its parent's title and a colon. */
function titledAsPartOf(node: WorkNode): boolean {
  if (!node.parentTitle) return false;
  return node.title.startsWith(`${node.parentTitle}:`);
}

export function workLevelOf(node: WorkNode): WorkLevel {
  // A work with parts is the thing those parts belong to.
  if (node.hasChildren) return { mbid: node.mbid, reason: 'has-parts', needsReview: false };

  // MusicBrainz types works, not movements. An Étude, a Sonata or an Aria is
  // a piece in its own right however deeply it is filed — this is what keeps
  // twenty-four Chopin études from collapsing into "12 Études, Op. 10".
  if (node.type) return { mbid: node.mbid, reason: 'typed', needsReview: false };

  if (!node.parentMbid) return { mbid: node.mbid, reason: 'no-parent', needsReview: false };

  if (titledAsPartOf(node)) {
    return { mbid: node.parentMbid, reason: 'titled-as-part', needsReview: false };
  }

  // A childless, untyped work whose title does not name its parent. It might
  // be a movement whose parent is titled differently, or a piece inside a
  // collection. Those want opposite answers and nothing here distinguishes
  // them, so it stays put and says so.
  return { mbid: node.mbid, reason: 'unresolved', needsReview: true };
}
