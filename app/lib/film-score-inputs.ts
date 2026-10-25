import { eq, is, sql, SQL } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './db';
import { jsonList } from './db/chunked';
import { spotifyAlbum, spotifyTrack, trackArtists } from './db/schema';
import type { FilmScoreTrack } from './film-scores';

export type FilmScoreTrackInput = Omit<FilmScoreTrack, 'workMbids'>;

// A track we have no row for comes back with no artists and no album, which is what the rule is
// given for it.
export async function filmScoreInputs(
  /** Or a select of them, so the read needn't wait for the ids. */
  spotifyTrackIds: Iterable<string> | SQL,
  database: DatabaseExecutor = db,
): Promise<(spotifyTrackId: string) => FilmScoreTrackInput> {
  const ids = is(spotifyTrackIds, SQL) ? spotifyTrackIds : jsonList(spotifyTrackIds);
  const [albumRows, artistRows] = await Promise.all([
    database
      .select({
        spotifyTrackId: spotifyTrack.spotifyId,
        spotifyAlbumId: spotifyAlbum.spotifyId,
        title: spotifyAlbum.title,
      })
      .from(spotifyTrack)
      .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
      .where(sql`${spotifyTrack.spotifyId} in (${ids})`),
    database
      .select()
      .from(trackArtists)
      .where(sql`${trackArtists.spotifyTrackId} in (${ids})`),
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
