import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  mbArtist,
  mbRecordingCredit,
  mbRelease,
  mbReleaseTrack,
  spotifyAlbum,
  spotifyTrack,
  trackRecording,
} from '../db/schema';
import { filmScoreExclusions } from '../film-score-exclusions';
import { mbReleasePickHit, normalisePickBarcode, type MbPickHit } from '../musicbrainz-pick';
import { within, without } from './scope';

// Stays human permanently: duplicate releases are expensive for others to merge. Ordered by how
// much of the library each unlocks.
export type MissingRelease = {
  albumId: string;
  albumTitle: string;
  year: number | null;
  upc: string | null;
  tracks: number;
  unanchored: number;
  reason: string;
};

export async function missingReleases(
  scope: { albumIds?: readonly string[] } = {},
): Promise<MissingRelease[]> {
  const film = await filmScoreExclusions(scope.albumIds);
  return db
    .select({
      albumId: spotifyAlbum.spotifyId,
      albumTitle: spotifyAlbum.title,
      year: spotifyAlbum.year,
      upc: sql<string | null>`${spotifyAlbum.upc}`,
      tracks: sql<number>`count(distinct ${spotifyTrack.spotifyId})`,
      unanchored: sql<number>`count(distinct case when not exists (
        select 1 from ${trackRecording} tr where tr.spotify_track_id = ${spotifyTrack.spotifyId}
      ) then ${spotifyTrack.spotifyId} end)`,
      reason: sql<string>`case
        when ${spotifyAlbum.upc} is null or ${spotifyAlbum.upc} = '' then 'Spotify gives no barcode'
        when coalesce(${spotifyAlbum.mbReleaseCandidates}, 0) > 1 then 'several releases share the barcode'
        else 'no release carries this barcode'
      end`,
    })
    .from(spotifyAlbum)
    .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyAlbumId, spotifyAlbum.spotifyId))
    .where(
      and(
        within(spotifyAlbum.spotifyId, scope.albumIds),
        sql`${spotifyAlbum.mbReleaseId} is null`,
        without(spotifyAlbum.spotifyId, film.albumIds),
        without(spotifyTrack.spotifyId, film.trackIds),
      ),
    )
    .groupBy(spotifyAlbum.spotifyId)
    .orderBy(sql`count(distinct ${spotifyTrack.spotifyId}) desc`, spotifyAlbum.spotifyId);
}

// The matcher discarded these MBIDs; this shows what those releases left in `mb_release`, without a
// live search.
export async function cachedReleasesSharingBarcodes(
  upcs: string[],
): Promise<Map<string, MbPickHit[]>> {
  const normalized = [
    ...new Set(
      upcs.map((upc) => normalisePickBarcode(upc)).filter((upc): upc is string => Boolean(upc)),
    ),
  ];
  const byBarcode = new Map<string, MbPickHit[]>();
  if (normalized.length === 0) return byBarcode;

  const releases = await db
    .select({
      mbid: mbRelease.mbid,
      title: mbRelease.title,
      date: mbRelease.date,
      country: mbRelease.country,
      barcode: mbRelease.barcode,
    })
    .from(mbRelease)
    .where(
      sql`ltrim(coalesce(${mbRelease.barcode}, ''), '0') in (${sql.join(
        normalized.map((value) => sql`${value}`),
        sql`, `,
      )})`,
    );
  if (releases.length === 0) return byBarcode;

  const mbids = releases.map((release) => release.mbid);
  const [trackRows, firstTracks] = await Promise.all([
    db
      .select({
        releaseMbid: mbReleaseTrack.releaseMbid,
        tracks: sql<number>`count(*)`,
        mediums: sql<number>`count(distinct ${mbReleaseTrack.medium})`,
      })
      .from(mbReleaseTrack)
      .where(inArray(mbReleaseTrack.releaseMbid, mbids))
      .groupBy(mbReleaseTrack.releaseMbid),
    db
      .select({
        releaseMbid: mbReleaseTrack.releaseMbid,
        recordingMbid: mbReleaseTrack.recordingMbid,
      })
      .from(mbReleaseTrack)
      .where(
        and(
          inArray(mbReleaseTrack.releaseMbid, mbids),
          eq(mbReleaseTrack.medium, 1),
          eq(mbReleaseTrack.position, 1),
        ),
      ),
  ]);
  const tracksByRelease = new Map(trackRows.map((row) => [row.releaseMbid, row]));
  const firstRecording = firstTracks.map((row) => row.recordingMbid);
  const creditRows =
    firstRecording.length === 0
      ? []
      : await db
          .select({
            recordingMbid: mbRecordingCredit.recordingMbid,
            name: mbArtist.name,
            creditedName: mbArtist.creditedName,
          })
          .from(mbRecordingCredit)
          .innerJoin(mbArtist, eq(mbArtist.mbid, mbRecordingCredit.artistMbid))
          .where(inArray(mbRecordingCredit.recordingMbid, firstRecording));
  const namesByRecording = new Map<string, string[]>();
  for (const row of creditRows) {
    const names = namesByRecording.get(row.recordingMbid) ?? [];
    names.push(row.creditedName || row.name);
    namesByRecording.set(row.recordingMbid, [...new Set(names)]);
  }
  const recordingByRelease = new Map(
    firstTracks.map((row) => [row.releaseMbid, row.recordingMbid]),
  );

  for (const release of releases) {
    const key = normalisePickBarcode(release.barcode);
    if (!key) continue;
    const tracks = tracksByRelease.get(release.mbid);
    const recordingMbid = recordingByRelease.get(release.mbid);
    const hit = mbReleasePickHit({
      mbid: release.mbid,
      title: release.title,
      date: release.date,
      country: release.country,
      artistNames: recordingMbid ? (namesByRecording.get(recordingMbid) ?? []) : [],
      trackCount: tracks?.tracks ?? 0,
      mediumCount: tracks?.mediums ?? 0,
    });
    const list = byBarcode.get(key) ?? [];
    list.push(hit);
    byBarcode.set(key, list);
  }
  for (const hits of byBarcode.values()) {
    hits.sort((a, b) => a.title.localeCompare(b.title) || a.mbid.localeCompare(b.mbid));
  }
  return byBarcode;
}
