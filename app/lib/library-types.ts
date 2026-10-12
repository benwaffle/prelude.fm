import type { Era, LibraryWork, Movement } from './prelude';

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
  /** Null where nothing has aggregated it. */
  popularity: number | null;
  tint: string;
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
  movementCount: number;
  /** Including ones this recording lacks. */
  partCount: number;
  unmatched: boolean;
  movements: Pick<Movement, 'roman' | 'name' | 'unnamed' | 'duration' | 'missing'>[];
  /** So the page can tell which works are already in the reader's library. */
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
  /** Null when `work.form` is unrecorded. */
  genre: string | null;
  movementCount: number;
  recordingCount: number;
}

export interface CatalogRecording extends RecordingSummary {
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
