import {
  indexWorks,
  resolveDisplayWork,
  type DisplayWorkNode,
  type DisplayWorkReference,
} from './musicbrainz-display-work';

// Uses `resolveDisplayWork`, as the library does, so a card's catalogue number lands on the same
// work.

export type CatalogueWorkNode = DisplayWorkNode;

export type CatalogueReference = DisplayWorkReference & {
  system: string;
  number: string;
};

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
  reference: CatalogueReference | null;
  /** MusicBrainz recordings, and `track:<spotify id>` for a track with none. */
  holdings: string[];
};

/** A work the cache does not hold stays in the list, untitled. */
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
