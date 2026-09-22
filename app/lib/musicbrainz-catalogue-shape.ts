import { workLevelOf } from './musicbrainz-work-level';
import { ancestry, nearestAncestorWith } from './musicbrainz-work-tree';

/**
 * Which MusicBrainz work a held recording belongs under, and what that work
 * is called.
 *
 * The catalogue has to agree with the library about what counts as a work,
 * or clicking a card's catalogue number would land on a work the catalogue
 * has never heard of. Both use `workLevelOf`, and both take the catalogue
 * reference and the composer from the nearest ancestor that carries one,
 * because that is where MusicBrainz files them.
 */

export type CatalogueWorkNode = {
  mbid: string;
  title: string;
  type: string | null;
  parentMbid: string | null;
  orderingKey: number | null;
  composerMbid: string | null;
};

export type CatalogueReference = {
  workMbid: string;
  system: string;
  number: string;
};

export type ShapedCatalogueWork = {
  mbid: string;
  title: string;
  type: string | null;
  composerMbid: string | null;
  /** The nearest reference at or above the work, if MusicBrainz has one. */
  reference: CatalogueReference | null;
  recordingMbids: string[];
};

/**
 * Groups held recordings under the work a reader would call theirs.
 *
 * `relations` is recording → the work MusicBrainz relates it to; the level
 * rule then decides whether that work, or the one above it, is the thing to
 * show.
 */
export function shapeHeldCatalogue(
  relations: Array<{ recordingMbid: string; workMbid: string }>,
  works: CatalogueWorkNode[],
  references: CatalogueReference[],
): ShapedCatalogueWork[] {
  const byMbid = new Map(works.map((work) => [work.mbid, work]));
  const parents = new Set(
    works.map((work) => work.parentMbid).filter((mbid): mbid is string => mbid !== null),
  );
  const referencesByWork = new Map<string, CatalogueReference>();
  for (const reference of references) {
    if (!referencesByWork.has(reference.workMbid))
      referencesByWork.set(reference.workMbid, reference);
  }

  const shaped = new Map<string, ShapedCatalogueWork>();
  for (const relation of relations) {
    const related = byMbid.get(relation.workMbid);
    if (!related) continue;
    const parent = related.parentMbid ? byMbid.get(related.parentMbid) : undefined;
    const level = workLevelOf({
      mbid: related.mbid,
      title: related.title,
      type: related.type,
      parentMbid: related.parentMbid,
      parentTitle: parent?.title ?? null,
      hasChildren: parents.has(related.mbid),
      orderingKey: related.orderingKey,
    });
    const display = byMbid.get(level.mbid);
    if (!display) continue;

    const existing = shaped.get(display.mbid);
    if (existing) {
      if (!existing.recordingMbids.includes(relation.recordingMbid)) {
        existing.recordingMbids.push(relation.recordingMbid);
      }
      continue;
    }
    const carrier = nearestAncestorWith(display.mbid, byMbid, (node) =>
      referencesByWork.has(node.mbid),
    );
    shaped.set(display.mbid, {
      mbid: display.mbid,
      title: display.title,
      type: display.type,
      composerMbid:
        ancestry(display.mbid, byMbid).find((node) => node.composerMbid)?.composerMbid ?? null,
      reference: carrier ? (referencesByWork.get(carrier.mbid) ?? null) : null,
      recordingMbids: [relation.recordingMbid],
    });
  }
  return Array.from(shaped.values());
}
