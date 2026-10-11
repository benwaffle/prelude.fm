export interface WorkSearchHit {
  workId: string;
  /** Null when the MusicBrainz cache does not hold the work. */
  title: string | null;
  nickname: string | null;
  composerId: string;
  composerName: string;
  /** The reference the search matched on, which may not be the primary one. */
  matchedOn: string | null;
  /** Every reference the work carries, so the reader can see what it is called. */
  references: string[];
  recordingCount: number;
}
