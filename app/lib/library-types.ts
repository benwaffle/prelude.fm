import type { Era, LibraryWork } from './prelude';

export interface OtherRecording {
  recordingId: string;
  albumId: string;
  album: string;
  cover: string | null;
  year: number | null;
  performer: string | null;
  ensemble: string | null;
  durationMs: number | null;
  duration: string | null;
  unmatched: boolean;
  popularity: number | null;
  tint: string;
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
  movements: { roman: string; name: string; duration: string | null; missing: boolean }[];
}

export interface WorkDetail {
  work: LibraryWork;
  others: OtherRecording[];
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
  title: string;
  nickname: string | null;
  catalog: string | null;
  year: number | null;
  /** null when `work.form` is unrecorded. */
  genre: string | null;
  movementCount: number;
  recordingCount: number;
}

export interface CatalogRecording {
  id: string;
  album: string;
  albumId: string;
  cover: string | null;
  year: number | null;
  performer: string | null;
  ensemble: string | null;
  duration: string | null;
  popularity: number | null;
  tint: string;
  /** How many movements of this recording the user has saved. */
  liked: number;
  firstTrackUri: string | null;
  /** This recording has no tracks mapped to canonical work parts. */
  unmatched: boolean;
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
