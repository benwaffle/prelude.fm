'use server';

export interface WorkSibling {
  /** Our work, when we hold one for this part of the collection. */
  workId: string | null;
  title: string;
  /** Its position among the parent's parts, as MusicBrainz orders them. */
  ordering: number | null;
  isCurrent: boolean;
}

export interface WorkParent {
  title: string;
  /** Every part MusicBrainz lists, including ones we do not have. */
  siblings: WorkSibling[];
  /** How many of those parts we hold a work for. */
  held: number;
}
