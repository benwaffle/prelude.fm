import { eq, sql } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './db';
import { jsonList } from './db/chunked';
import { spotifyAlbum, spotifyTrack, trackArtists } from './db/schema';
import type { FilmScoreTrack } from './film-scores';

/** What `filmScoreReason` needs to know about a track beyond its works. */
export type FilmScoreTrackInput = Omit<FilmScoreTrack, 'workMbids'>;

/**
 * The Spotify side of the film-score rule for these tracks: who Spotify
 * credits, and the album they are on. A track we have no row for comes back
 * with no artists and no album, which is what the rule is given for it.
 */
export async function filmScoreInputs(
  spotifyTrackIds: Iterable<string>,
  database: DatabaseExecutor = db,
): Promise<(spotifyTrackId: string) => FilmScoreTrackInput> {
  const ids = [...new Set(spotifyTrackIds)];
  const [albumRows, artistRows] = await Promise.all([
    database
      .select({
        spotifyTrackId: spotifyTrack.spotifyId,
        spotifyAlbumId: spotifyAlbum.spotifyId,
        title: spotifyAlbum.title,
      })
      .from(spotifyTrack)
      .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
      .where(sql`${spotifyTrack.spotifyId} in (${jsonList(ids)})`),
    database
      .select()
      .from(trackArtists)
      .where(sql`${trackArtists.spotifyTrackId} in (${jsonList(ids)})`),
  ]);
  const albumByTrack = new Map(
    albumRows.map((row) => [
      row.spotifyTrackId,
      { spotifyAlbumId: row.spotifyAlbumId, title: row.title },
    ]),
  );
  const artistIdsByTrack = new Map<string, string[]>();
  for (const row of artistRows) {
    artistIdsByTrack.set(row.spotifyTrackId, [
      ...(artistIdsByTrack.get(row.spotifyTrackId) ?? []),
      row.spotifyArtistId,
    ]);
  }
  return (spotifyTrackId) => ({
    spotifyArtistIds: artistIdsByTrack.get(spotifyTrackId) ?? [],
    album: albumByTrack.get(spotifyTrackId) ?? null,
  });
}
