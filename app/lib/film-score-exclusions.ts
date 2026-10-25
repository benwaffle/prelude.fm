// For screens that query the DB directly. Candidates are found cheaply, then the classifier
// decides, so the Inbox and the library agree on what a film score is.

import { db } from './db';
import { forChunks, jsonList } from './db/chunked';
import { spotifyAlbum, spotifyTrack } from './db/schema';
import { inArray, is, SQL, sql } from 'drizzle-orm';
import { FILM_COMPOSERS, isFilmScoreReason, isSoundtrackAlbum } from './film-scores';
import { classifyTracks } from './musicbrainz-track-classification';

export type FilmScoreExclusions = {
  trackIds: string[];
  // A soundtrack album with one Schubert song on it is still not worth fixing on MusicBrainz for
  // this catalogue.
  albumIds: string[];
  isrcs: string[];
};

/**
 * The albums to read: their IDs, or a select of them. Undefined reads the whole library, which only
 * a script should ask for: the Inbox reads a window of albums (`gaps/album-window`).
 */
export type FilmScoreScope = readonly string[] | SQL;

/** The Inbox asks several times per load, for the same albums; the answer barely moves. */
const CACHE_MS = 60_000;
const CACHE_ENTRIES = 8;
const cache = new Map<string, { at: number; value: Promise<FilmScoreExclusions> }>();

export function filmScoreExclusions(albums?: FilmScoreScope): Promise<FilmScoreExclusions> {
  // A select is asked once (one row's own action): not worth a key.
  if (is(albums, SQL)) return loadFilmScoreExclusions(albums);
  const key = albums ? [...albums].join(',') : '*';
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at <= CACHE_MS) return cached.value;
  const value = loadFilmScoreExclusions(albums).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}

async function loadFilmScoreExclusions(albums?: FilmScoreScope): Promise<FilmScoreExclusions> {
  const inScope = (albumId: SQL) =>
    albums === undefined
      ? sql`1`
      : sql`${albumId} in (${is(albums, SQL) ? albums : jsonList(albums)})`;
  const composerMbids = FILM_COMPOSERS.map((composer) => composer.mbid);
  const spotifyIds = FILM_COMPOSERS.flatMap((composer) =>
    composer.spotifyId ? [composer.spotifyId] : [],
  );
  const albumRows = await db
    .select({ spotifyAlbumId: spotifyAlbum.spotifyId, title: spotifyAlbum.title })
    .from(spotifyAlbum)
    .where(inScope(sql`${spotifyAlbum.spotifyId}`));
  const soundtrackAlbumIds = albumRows
    .filter(isSoundtrackAlbum)
    .map((album) => album.spotifyAlbumId);

  // A superset of what the rule can mark; the facts loader then decides each one.
  const candidates = await db.all<{ id: string }>(sql`
    with recursive film_work(mbid) as (
      select mbid from mb_work where composer_mbid in (${sql.join(
        composerMbids.map((mbid) => sql`${mbid}`),
        sql`, `,
      )})
      union
      select w.mbid from mb_work w join film_work f on w.parent_mbid = f.mbid
    )
    select tr.spotify_track_id as id
      from spotify_track t
      join track_recording tr on tr.spotify_track_id = t.spotify_id
      join mb_recording_work rw on rw.recording_mbid = tr.recording_mbid
      where ${inScope(sql`t.spotify_album_id`)} and rw.work_mbid in (select mbid from film_work)
    union
    select t.spotify_id as id
      from spotify_track t
      join mb_recording_isrc ri on ri.isrc = t.isrc
      join mb_recording_work rw on rw.recording_mbid = ri.recording_mbid
      where ${inScope(sql`t.spotify_album_id`)} and rw.work_mbid in (select mbid from film_work)
    union
    select ta.spotify_track_id as id
      from spotify_track t
      join track_artists ta on ta.spotify_track_id = t.spotify_id
      where ${inScope(sql`t.spotify_album_id`)} and ta.spotify_artist_id in (${sql.join(
        spotifyIds.map((id) => sql`${id}`),
        sql`, `,
      )})
  `);
  const soundtrackTracks = await forChunks(soundtrackAlbumIds, (chunk) =>
    db
      .select({ id: spotifyTrack.spotifyId })
      .from(spotifyTrack)
      .where(inArray(spotifyTrack.spotifyAlbumId, chunk)),
  );
  const candidateIds = [...new Set([...candidates, ...soundtrackTracks].map((row) => row.id))];
  if (candidateIds.length === 0) return { trackIds: [], albumIds: soundtrackAlbumIds, isrcs: [] };

  const classifications = await classifyTracks(candidateIds, { preferStored: true });
  const trackIds = new Set(
    classifications
      .filter((classification) => isFilmScoreReason(classification.reason))
      .map((classification) => classification.spotifyTrackId),
  );
  if (trackIds.size === 0) return { trackIds: [], albumIds: soundtrackAlbumIds, isrcs: [] };

  const albumTracks = await db
    .select({
      id: spotifyTrack.spotifyId,
      albumId: spotifyTrack.spotifyAlbumId,
      isrc: spotifyTrack.isrc,
    })
    .from(spotifyTrack)
    .where(
      sql`${spotifyTrack.spotifyAlbumId} in (select spotify_album_id from spotify_track where spotify_id in (${jsonList(trackIds)}))`,
    );
  const touchedAlbums = [
    ...new Set(albumTracks.filter((track) => trackIds.has(track.id)).map((track) => track.albumId)),
  ];
  const keptAlbums = new Set(
    albumTracks.filter((track) => !trackIds.has(track.id)).map((track) => track.albumId),
  );
  const isrcsKept = await forChunks(
    [...new Set(albumTracks.map((track) => track.isrc).filter((isrc): isrc is string => !!isrc))],
    (chunk) =>
      db
        .select({ id: spotifyTrack.spotifyId, isrc: spotifyTrack.isrc })
        .from(spotifyTrack)
        .where(inArray(spotifyTrack.isrc, chunk)),
  );
  const isrcInUse = new Set(
    isrcsKept.filter((row) => !trackIds.has(row.id)).map((row) => row.isrc),
  );
  return {
    trackIds: [...trackIds],
    albumIds: [
      ...new Set([
        ...soundtrackAlbumIds,
        ...touchedAlbums.filter((albumId) => !keptAlbums.has(albumId)),
      ]),
    ],
    isrcs: [
      ...new Set(
        albumTracks
          .filter((track) => trackIds.has(track.id) && track.isrc && !isrcInUse.has(track.isrc))
          .map((track) => track.isrc!),
      ),
    ],
  };
}
