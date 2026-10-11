/**
 * Which tracks, albums and ISRCs the film-score rule takes out, for screens
 * that read the database with their own queries instead of through the
 * facts loader — the Inbox lists above all.
 *
 * The rule itself stays in one place (`film-scores`, applied by the facts
 * loader). This finds every track the rule could possibly touch with a few
 * cheap queries, then asks the facts loader about just those, so the Inbox
 * and the library cannot disagree about what a film score is.
 */

import { loadMusicBrainzLibraryFacts } from '@/app/actions/library-musicbrainz';
import { db } from './db';
import { forChunks } from './db/chunked';
import { spotifyAlbum, spotifyTrack } from './db/schema';
import { inArray, sql } from 'drizzle-orm';
import { FILM_COMPOSERS, isFilmScoreReason, isSoundtrackAlbum } from './film-scores';

export type FilmScoreExclusions = {
  /** Every track the rule marks as a film score. */
  trackIds: string[];
  /**
   * Albums that are soundtracks, or have no track left once film scores are
   * taken out. A soundtrack album with one Schubert song on it is still not
   * an album worth fixing on MusicBrainz for this catalogue.
   */
  albumIds: string[];
  /** ISRCs carried only by film-score tracks. */
  isrcs: string[];
};

/** The Inbox asks several times per load; the answer barely moves. */
const CACHE_MS = 60_000;
let cache: { at: number; value: Promise<FilmScoreExclusions> } | null = null;

export function filmScoreExclusions(): Promise<FilmScoreExclusions> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = {
      at: Date.now(),
      value: loadFilmScoreExclusions().catch((error) => {
        cache = null;
        throw error;
      }),
    };
  }
  return cache.value;
}

async function loadFilmScoreExclusions(): Promise<FilmScoreExclusions> {
  const composerMbids = FILM_COMPOSERS.map((composer) => composer.mbid);
  const spotifyIds = FILM_COMPOSERS.flatMap((composer) =>
    composer.spotifyId ? [composer.spotifyId] : [],
  );
  const albums = await db
    .select({ spotifyAlbumId: spotifyAlbum.spotifyId, title: spotifyAlbum.title })
    .from(spotifyAlbum);
  const soundtrackAlbumIds = albums.filter(isSoundtrackAlbum).map((album) => album.spotifyAlbumId);

  // A superset of what the rule can mark: works under a film composer (by
  // anchor or by ISRC), tracks Spotify credits to one, and everything on a
  // soundtrack album. The facts loader then decides each one.
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
      from track_recording tr
      join mb_recording_work rw on rw.recording_mbid = tr.recording_mbid
      where rw.work_mbid in (select mbid from film_work)
    union
    select t.spotify_id as id
      from spotify_track t
      join mb_recording_isrc ri on ri.isrc = t.isrc
      join mb_recording_work rw on rw.recording_mbid = ri.recording_mbid
      where rw.work_mbid in (select mbid from film_work)
    union
    select spotify_track_id as id from track_artists
      where spotify_artist_id in (${sql.join(
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

  const facts = await loadMusicBrainzLibraryFacts(candidateIds);
  const trackIds = new Set(
    facts.classifications
      .filter((classification) => isFilmScoreReason(classification.reason))
      .map((classification) => classification.spotifyTrackId),
  );
  if (trackIds.size === 0) return { trackIds: [], albumIds: soundtrackAlbumIds, isrcs: [] };

  const touchedAlbums = [
    ...new Set(
      facts.providerTracks
        .filter((track) => trackIds.has(track.spotifyTrackId))
        .map((track) => track.spotifyAlbumId),
    ),
  ];
  const albumTracks = await forChunks(touchedAlbums, (chunk) =>
    db
      .select({
        id: spotifyTrack.spotifyId,
        albumId: spotifyTrack.spotifyAlbumId,
        isrc: spotifyTrack.isrc,
      })
      .from(spotifyTrack)
      .where(inArray(spotifyTrack.spotifyAlbumId, chunk)),
  );
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
