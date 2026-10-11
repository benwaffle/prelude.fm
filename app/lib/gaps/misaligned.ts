import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { forChunks } from '../db/chunked';
import { mbReleaseTrack, spotifyAlbum, spotifyTrack, trackRecording } from '../db/schema';
import { filmScoreExclusions } from '../film-score-exclusions';
import {
  diagnoseTracklist,
  POSITION_TOLERANCE_MS,
  type TracklistDiagnosis,
} from '../musicbrainz-matching';
import type { TracklistMismatch } from '../submission-evidence';
import { within, without } from './scope';

/**
 * Albums whose tracklist does not line up with the release we matched.
 *
 * Anchoring refuses these, which is right, but refusing silently makes them
 * look like albums MusicBrainz simply has nothing for. They are the
 * opposite: MusicBrainz has the release and one of the two tracklists is
 * wrong. A reordered one is an error somebody can fix — and it is not
 * always MusicBrainz's, which is why this reports rather than submits.
 */
export type MisalignedAlbum = {
  albumId: string;
  albumTitle: string;
  releaseMbid: string;
  diagnosis: TracklistDiagnosis;
  /**
   * Only the positions that disagree.
   *
   * An album can line up for twenty tracks and part company on the
   * twenty-first; showing the first few rows would show the agreement and
   * hide the problem.
   */
  mismatches: TracklistMismatch[];
  ourCount: number;
  theirCount: number;
  /** Tracks anchored anyway, by ISRC, which needs no tracklist at all. */
  anchoredByIsrc: number;
};

export async function misalignedAlbums(
  scope: { albumIds?: readonly string[] } = {},
): Promise<MisalignedAlbum[]> {
  const film = await filmScoreExclusions();
  const albums = await db
    .select({
      albumId: spotifyAlbum.spotifyId,
      albumTitle: spotifyAlbum.title,
      releaseMbid: sql<string>`${spotifyAlbum.mbReleaseId}`,
    })
    .from(spotifyAlbum)
    .where(
      and(
        within(spotifyAlbum.spotifyId, scope.albumIds),
        without(spotifyAlbum.spotifyId, film.albumIds),
        sql`${spotifyAlbum.mbReleaseId} is not null`,
        sql`exists (select 1 from ${mbReleaseTrack} where ${mbReleaseTrack.releaseMbid} = ${spotifyAlbum.mbReleaseId})`,
      ),
    );
  if (albums.length === 0) return [];

  // Every album's two tracklists at once: one round trip per album was most
  // of an Inbox load.
  const albumIds = albums.map((album) => album.albumId);
  const [ourRows, theirRows, anchoredRows] = await Promise.all([
    forChunks(albumIds, (chunk) =>
      db
        .select({
          albumId: spotifyTrack.spotifyAlbumId,
          medium: spotifyTrack.discNumber,
          position: spotifyTrack.trackNumber,
          title: spotifyTrack.title,
          durationMs: spotifyTrack.durationMs,
        })
        .from(spotifyTrack)
        .where(inArray(spotifyTrack.spotifyAlbumId, chunk))
        .orderBy(spotifyTrack.discNumber, spotifyTrack.trackNumber),
    ),
    forChunks(
      albums.map((album) => album.releaseMbid),
      (chunk) =>
        db
          .select({
            releaseMbid: mbReleaseTrack.releaseMbid,
            medium: mbReleaseTrack.medium,
            position: mbReleaseTrack.position,
            title: mbReleaseTrack.title,
            length: mbReleaseTrack.length,
          })
          .from(mbReleaseTrack)
          .where(inArray(mbReleaseTrack.releaseMbid, chunk))
          .orderBy(mbReleaseTrack.medium, mbReleaseTrack.position),
    ),
    forChunks(albumIds, (chunk) =>
      db
        .select({ albumId: spotifyTrack.spotifyAlbumId, n: sql<number>`count(*)` })
        .from(trackRecording)
        .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId))
        .where(
          and(inArray(spotifyTrack.spotifyAlbumId, chunk), eq(trackRecording.matchedBy, 'isrc')),
        )
        .groupBy(spotifyTrack.spotifyAlbumId),
    ),
  ]);
  const oursByAlbum = Map.groupBy(ourRows, (row) => row.albumId);
  const theirsByRelease = Map.groupBy(theirRows, (row) => row.releaseMbid);
  const anchoredByAlbum = new Map(anchoredRows.map((row) => [row.albumId, row.n]));

  const out: MisalignedAlbum[] = [];
  for (const album of albums) {
    const ours = oursByAlbum.get(album.albumId) ?? [];
    const theirs = theirsByRelease.get(album.releaseMbid) ?? [];

    const diagnosis = diagnoseTracklist(
      ours.map((t) => ({
        discNumber: t.medium,
        trackNumber: t.position,
        durationMs: t.durationMs,
      })),
      theirs.map((t) => ({ medium: t.medium, position: t.position, length: t.length })),
    );
    if (diagnosis.kind === 'aligned') continue;

    const mismatches: TracklistMismatch[] = [];
    for (let i = 0; i < Math.max(ours.length, theirs.length); i++) {
      const ourTrack = ours[i];
      const theirTrack = theirs[i];
      const agree =
        ourTrack &&
        theirTrack &&
        theirTrack.length != null &&
        Math.abs(theirTrack.length - ourTrack.durationMs) <= POSITION_TOLERANCE_MS;
      if (agree) continue;
      mismatches.push({
        position: i + 1,
        ourTitle: ourTrack?.title ?? null,
        ourMs: ourTrack?.durationMs ?? null,
        theirTitle: theirTrack?.title ?? null,
        theirMs: theirTrack?.length ?? null,
      });
      if (mismatches.length >= 8) break;
    }

    out.push({
      ...album,
      diagnosis,
      mismatches,
      ourCount: ours.length,
      theirCount: theirs.length,
      anchoredByIsrc: anchoredByAlbum.get(album.albumId) ?? 0,
    });
  }

  // Reordered first: it is the one that is plainly somebody's error.
  const rank = (a: MisalignedAlbum) => (a.diagnosis.kind === 'reordered' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.albumId.localeCompare(b.albumId));
}
