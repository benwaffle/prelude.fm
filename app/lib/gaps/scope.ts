import { inArray, notInArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { jsonList } from '../db/chunked';

/** Film scores are not part of the catalogue (see `film-scores`). */
export function without(column: SQLWrapper, ids: string[]) {
  return ids.length === 0 ? undefined : notInArray(column as never, ids);
}

/** Undefined reads the whole list; an empty list reads nothing. */
export function within(column: SQLWrapper, ids: readonly string[] | undefined) {
  return ids === undefined ? undefined : inArray(column as never, [...ids]);
}

// The albums a scoped gap read covers, so its film-score exclusions read only those (a select of
// album IDs). Undefined when the read is unscoped, as a script reading the whole library is.
export function albumsOfReleases(releaseMbids: readonly string[] | undefined): SQL | undefined {
  return releaseMbids
    ? sql`select spotify_id from spotify_album where mb_release_id in (${jsonList(releaseMbids)})`
    : undefined;
}

export function albumsOfRecordings(recordingMbids: readonly string[] | undefined): SQL | undefined {
  return recordingMbids
    ? sql`select t.spotify_album_id from track_recording tr join spotify_track t on t.spotify_id = tr.spotify_track_id where tr.recording_mbid in (${jsonList(recordingMbids)})`
    : undefined;
}

export function albumsOfIsrcs(isrcs: readonly string[] | undefined): SQL | undefined {
  return isrcs
    ? sql`select spotify_album_id from spotify_track where isrc in (${jsonList(isrcs)})`
    : undefined;
}
