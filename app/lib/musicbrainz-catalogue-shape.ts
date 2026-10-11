import {
  indexWorks,
  resolveDisplayWork,
  type DisplayWorkNode,
  type DisplayWorkReference,
} from './musicbrainz-display-work';

/**
 * Which MusicBrainz work a held recording belongs under, and what that work
 * is called.
 *
 * The catalogue has to agree with the library about what counts as a work,
 * or clicking a card's catalogue number would land on a work the catalogue
 * has never heard of. Both use `resolveDisplayWork`.
 */

export type CatalogueWorkNode = DisplayWorkNode;

export type CatalogueReference = DisplayWorkReference & {
  system: string;
  number: string;
};

/** A held track of a work: a MusicBrainz recording, or a track we linked ourselves. */
export type HeldRelation = {
  recordingMbid: string | null;
  spotifyTrackId: string;
  workMbid: string;
};

export type ShapedCatalogueWork = {
  mbid: string;
  /** Null when the cache does not hold the work, which is a gap to show, not a row to drop. */
  title: string | null;
  type: string | null;
  composerMbid: string | null;
  /** The first of the nearest references at or above the work, if MusicBrainz has one. */
  reference: CatalogueReference | null;
  /** MusicBrainz recordings, and `track:<spotify id>` for a track with none. */
  holdings: string[];
};

/**
 * Groups held recordings under the work a reader would call theirs.
 *
 * `relations` is held track → the work it is of; the level rule then decides
 * whether that work, or the one above it, is the thing to show. A work the
 * cache does not hold stays in the list, untitled.
 */
export function shapeHeldCatalogue(
  relations: HeldRelation[],
  works: CatalogueWorkNode[],
  references: CatalogueReference[],
): ShapedCatalogueWork[] {
  const index = indexWorks(works, references);
  const shaped = new Map<string, ShapedCatalogueWork>();
  for (const relation of relations) {
    const holding = relation.recordingMbid ?? `track:${relation.spotifyTrackId}`;
    const resolved = resolveDisplayWork(relation.workMbid, index);
    const mbid = resolved.level?.mbid ?? relation.workMbid;
    const existing = shaped.get(mbid);
    if (existing) {
      if (!existing.holdings.includes(holding)) existing.holdings.push(holding);
      continue;
    }
    shaped.set(mbid, {
      mbid,
      title: resolved.display?.title ?? null,
      type: resolved.display?.type ?? null,
      composerMbid: resolved.composerMbid,
      reference: resolved.references[0] ?? null,
      holdings: [holding],
    });
  }
  return Array.from(shaped.values());
}
