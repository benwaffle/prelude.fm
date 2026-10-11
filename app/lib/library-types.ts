import type { Era, LibraryWork, Movement } from './prelude';

/** One recording of a work, as a tile that links to its page. */
export interface RecordingSummary {
  recordingId: string;
  albumId: string;
  album: string;
  cover: string | null;
  year: number | null;
  performer: string | null;
  ensemble: string | null;
  /** Null when none of its tracks has a duration (or none is mapped). */
  duration: string | null;
  /** Spotify popularity; null where nothing has aggregated it. */
  popularity: number | null;
  tint: string;
  /** This recording has no tracks mapped to canonical work parts. */
  unmatched: boolean;
}

export interface WorkSummary {
  workId: string;
  recordingId: string;
  /** Null where the reader has no title for the work, as on a library card. */
  title: string | null;
  nickname: string | null;
  catalog: string | null;
  year: number | null;
  cover: string | null;
  album: string | null;
  performer: string | null;
  ensemble: string | null;
  /** Movements this recording actually carries. */
  movementCount: number;
  /** Parts the work has in total, including ones this recording lacks. */
  partCount: number;
  /** The recording's tracks were never matched to movements. */
  unmatched: boolean;
  movements: Pick<Movement, 'roman' | 'name' | 'unnamed' | 'duration' | 'missing'>[];
  /** Every Spotify track we hold of this work, in any recording, so the page
   *  can tell which works are already in the reader's library. */
  trackIds: string[];
}

export interface WorkDetail {
  work: LibraryWork;
  others: RecordingSummary[];
  moreByComposer: WorkSummary[];
}

export interface CatalogComposer {
  id: string;
  name: string;
  short: string;
  sort: string;
  era: Era | null;
  born: number | null;
  died: number | null;
  years: string;
  /** The composer's Spotify artist portrait, when we have one. */
  image: string | null;
  workCount: number;
  recordingCount: number;
}

export interface CatalogWork {
  id: string;
  /** Null when the MusicBrainz cache does not hold the work. */
  title: string | null;
  nickname: string | null;
  catalog: string | null;
  year: number | null;
  /** null when `work.form` is unrecorded. */
  genre: string | null;
  movementCount: number;
  recordingCount: number;
}

export interface CatalogRecording extends RecordingSummary {
  /** How many movements of this recording the user has saved. */
  liked: number;
}

export interface CatalogWorkHeader {
  id: string;
  title: string;
  nickname: string | null;
  catalog: string | null;
  year: number | null;
  genre: string | null;
  /** Null where the reader does not know who wrote it. */
  composerName: string | null;
  movementCount: number;
}

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
