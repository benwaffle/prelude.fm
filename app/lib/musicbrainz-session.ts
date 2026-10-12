// Counts requests actually sent, retries included: a retry is a request the server had to serve.
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
  get<T>(path: string): Promise<T | null>;
  work(mbid: string): Promise<MbWork | null>;
  release(mbid: string): Promise<MbReleaseDetail | null>;
  recordingsByIsrcs(isrcs: string[]): Promise<MbIsrcHit[]>;
  readAndCacheWork(mbid: string): Promise<MbWork | null>;
  ingestWorkTree(mbid: string): Promise<void>;
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
