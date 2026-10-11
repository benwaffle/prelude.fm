/**
 * A run's MusicBrainz client: every read goes out on one channel and is
 * counted, so the run can say what it spent.
 *
 * The count is of requests actually sent, retries included — a retry is a
 * request the server had to serve, and a run that hit a busy MusicBrainz
 * really did cost more. Batch jobs store this number beside what they found.
 */
import {
  getReleaseWithRecordings,
  mbGet,
  musicBrainzApi,
  searchRecordingsByIsrcs,
  type MbIsrcHit,
  type MbReleaseDetail,
  type MbWork,
} from './musicbrainz';
import { ingestWorkTree, readAndCacheWork } from './musicbrainz-cache';
import type { MusicBrainzChannel } from './musicbrainz-gateway';

export type MbSession = {
  /** A raw web-service read, for queries the source has no method for. */
  get<T>(path: string): Promise<T | null>;
  work(mbid: string): Promise<MbWork | null>;
  release(mbid: string): Promise<MbReleaseDetail | null>;
  recordingsByIsrcs(isrcs: string[]): Promise<MbIsrcHit[]>;
  /** Read a work into the cache and return it. */
  readAndCacheWork(mbid: string): Promise<MbWork | null>;
  /** Read a work and its ancestors into the cache, skipping any already read in full. */
  ingestWorkTree(mbid: string): Promise<void>;
  /** Requests sent so far. */
  readonly requests: number;
};

export function createMbSession(channel: MusicBrainzChannel): MbSession {
  let requests = 0;
  const onAttempt = () => {
    requests++;
  };
  const source = musicBrainzApi(channel, onAttempt);
  return {
    get: <T>(path: string) => mbGet<T>(path, channel, onAttempt),
    work: source.work,
    release: (mbid) => getReleaseWithRecordings(mbid, channel, onAttempt),
    recordingsByIsrcs: (isrcs) => searchRecordingsByIsrcs(isrcs, channel, onAttempt),
    readAndCacheWork: (mbid) => readAndCacheWork(source, mbid),
    ingestWorkTree: async (mbid) => {
      await ingestWorkTree(source, mbid);
    },
    get requests() {
      return requests;
    },
  };
}
