/**
 * Bringing a Spotify album into the MusicBrainz cache.
 *
 * Two questions, in order. Which MusicBrainz release is this album? And which
 * recording is each of its tracks? The first costs requests and is where the
 * judgement lives; the second is a local join once the first is answered.
 *
 * Both refuse to guess. An album that matches two releases equally well is
 * left unmatched, because a wrong release attaches every track on it to the
 * wrong recording, and that error is invisible afterwards — the tracks all
 * have plausible titles and plausible works.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from './db';
import {
  mbRecording,
  mbRecordingIsrc,
  mbRelease,
  mbReleaseTrack,
  spotifyAlbum,
  spotifyTrack,
  trackRecording,
} from './db/schema';
import { ingestRelease, type ReleaseIngestReport } from './musicbrainz-cache';
import {
  findReleaseForAlbum,
  tracklistAligns,
  type ReleaseMatch,
  type ReleaseMatchFailure,
} from './musicbrainz-matching';
import type { MusicBrainzSource } from './musicbrainz-source';

export { findReleaseForAlbum, releaseFitsAlbum } from './musicbrainz-matching';
export type {
  AlbumIdentity,
  AlbumTrack,
  ReleaseMatch,
  ReleaseMatchFailure,
} from './musicbrainz-matching';

/* ------------------------------------------------ which recording is it --- */

export type AnchorReport = {
  anchored: number;
  byIsrc: number;
  byPosition: number;
  unanchored: number;
  /** Whether the release's tracklist lines up with the album's, position for position. */
  tracklistAligned: boolean;
  /** ISRCs MusicBrainz maps to more than one recording; an upstream defect worth reporting. */
  contestedIsrcs: string[];
  /**
   * Tracks whose ISRC and whose position name different recordings.
   *
   * Always resolved in the ISRC's favour, but counted rather than swallowed:
   * it means either a mis-attached ISRC upstream or a release that is not
   * quite the edition we think it is, and both are worth knowing about.
   */
  isrcPositionDisagreements: number;
};

/**
 * Attach each Spotify track on an album to a MusicBrainz recording.
 *
 * ISRC first — it is the label's own identifier for the recording and needs no
 * corroboration. Then position, but only if the album's whole tracklist lines
 * up with the release's, because a position is only as good as the tracklist
 * it is a position in.
 *
 * Costs no requests: everything it needs is already cached.
 */
export async function anchorAlbumTracks(
  albumId: string,
  releaseMbid: string,
): Promise<AnchorReport> {
  const tracks = await db
    .select({
      spotifyId: spotifyTrack.spotifyId,
      title: spotifyTrack.title,
      discNumber: spotifyTrack.discNumber,
      trackNumber: spotifyTrack.trackNumber,
      durationMs: spotifyTrack.durationMs,
      isrc: spotifyTrack.isrc,
    })
    .from(spotifyTrack)
    .where(eq(spotifyTrack.spotifyAlbumId, albumId));

  const releaseTracks = await db
    .select({
      medium: mbReleaseTrack.medium,
      position: mbReleaseTrack.position,
      recordingMbid: mbReleaseTrack.recordingMbid,
      trackLength: mbReleaseTrack.length,
      recordingLength: mbRecording.length,
    })
    .from(mbReleaseTrack)
    .leftJoin(mbRecording, eq(mbRecording.mbid, mbReleaseTrack.recordingMbid))
    .where(eq(mbReleaseTrack.releaseMbid, releaseMbid));

  const byPosition = new Map(
    releaseTracks.map((track) => [`${track.medium}:${track.position}`, track]),
  );

  const aligned = tracklistAligns(
    tracks,
    releaseTracks.map((track) => ({
      medium: track.medium,
      position: track.position,
      length: track.trackLength ?? track.recordingLength,
    })),
  );

  const isrcs = tracks.flatMap((track) => (track.isrc ? [track.isrc] : []));
  const isrcRows = isrcs.length
    ? await db
        .select({ isrc: mbRecordingIsrc.isrc, recordingMbid: mbRecordingIsrc.recordingMbid })
        .from(mbRecordingIsrc)
        .where(inArray(mbRecordingIsrc.isrc, isrcs))
    : [];
  const recordingsByIsrc = new Map<string, Set<string>>();
  for (const row of isrcRows) {
    const set = recordingsByIsrc.get(row.isrc) ?? new Set<string>();
    set.add(row.recordingMbid);
    recordingsByIsrc.set(row.isrc, set);
  }

  const report: AnchorReport = {
    anchored: 0,
    byIsrc: 0,
    byPosition: 0,
    unanchored: 0,
    tracklistAligned: aligned,
    contestedIsrcs: [],
    isrcPositionDisagreements: 0,
  };

  const rows: {
    spotifyTrackId: string;
    recordingMbid: string;
    isrc: string | null;
    matchedBy: 'isrc' | 'release_position';
  }[] = [];

  for (const track of tracks) {
    const claimants = track.isrc ? recordingsByIsrc.get(track.isrc) : undefined;
    const positional = byPosition.get(`${track.discNumber}:${track.trackNumber}`);

    if (claimants && claimants.size === 1) {
      const [recordingMbid] = [...claimants];
      if (positional && positional.recordingMbid !== recordingMbid) {
        report.isrcPositionDisagreements++;
      }
      rows.push({
        spotifyTrackId: track.spotifyId,
        recordingMbid,
        isrc: track.isrc,
        matchedBy: 'isrc',
      });
      report.byIsrc++;
      continue;
    }

    // One ISRC on two recordings is an upstream error, not a tie to break.
    if (claimants && claimants.size > 1 && track.isrc) {
      report.contestedIsrcs.push(track.isrc);
    }

    if (aligned && positional) {
      rows.push({
        spotifyTrackId: track.spotifyId,
        recordingMbid: positional.recordingMbid,
        isrc: track.isrc,
        matchedBy: 'release_position',
      });
      report.byPosition++;
      continue;
    }

    report.unanchored++;
  }

  for (const row of rows) {
    await db
      .insert(trackRecording)
      .values({ ...row, matchedAt: new Date() })
      .onConflictDoUpdate({
        target: trackRecording.spotifyTrackId,
        set: { ...row, matchedAt: new Date() },
      });
  }

  report.anchored = rows.length;
  return report;
}

/* -------------------------------------------------------------- album --- */

export type AlbumIngestReport = {
  albumId: string;
  releaseMbid: string | null;
  matchedBy: ReleaseMatch['matchedBy'] | null;
  reason: ReleaseMatchFailure['reason'] | null;
  requests: number;
  release: ReleaseIngestReport | null;
  anchors: AnchorReport | null;
};

export async function ingestAlbum(
  source: MusicBrainzSource,
  albumId: string,
  options: { fetchWorks?: boolean } = {},
): Promise<AlbumIngestReport> {
  const [album] = await db
    .select({
      spotifyId: spotifyAlbum.spotifyId,
      title: spotifyAlbum.title,
      upc: spotifyAlbum.upc,
      mbReleaseId: spotifyAlbum.mbReleaseId,
    })
    .from(spotifyAlbum)
    .where(eq(spotifyAlbum.spotifyId, albumId));
  if (!album) throw new Error(`Unknown album ${albumId}`);

  const tracks = await db
    .select({
      spotifyId: spotifyTrack.spotifyId,
      title: spotifyTrack.title,
      discNumber: spotifyTrack.discNumber,
      trackNumber: spotifyTrack.trackNumber,
      durationMs: spotifyTrack.durationMs,
      isrc: spotifyTrack.isrc,
    })
    .from(spotifyTrack)
    .where(eq(spotifyTrack.spotifyAlbumId, albumId));

  const match = await findReleaseForAlbum(source, album, tracks);
  let requests = match.requests;

  if (match.releaseMbid === null) {
    await db
      .update(spotifyAlbum)
      .set({ mbCheckedAt: new Date(), mbReleaseCandidates: match.candidates.length })
      .where(eq(spotifyAlbum.spotifyId, albumId));
    return {
      albumId,
      releaseMbid: null,
      matchedBy: null,
      reason: match.reason,
      requests,
      release: null,
      anchors: null,
    };
  }

  const release = await ingestRelease(source, match.releaseMbid, options);
  requests += release.requests;

  if (!release.found) {
    return {
      albumId,
      releaseMbid: match.releaseMbid,
      matchedBy: match.matchedBy,
      reason: 'not_found',
      requests,
      release,
      anchors: null,
    };
  }

  await db
    .update(spotifyAlbum)
    .set({
      mbReleaseId: match.releaseMbid,
      mbCheckedAt: new Date(),
      mbReleaseCandidates: 1,
    })
    .where(eq(spotifyAlbum.spotifyId, albumId));

  const anchors = await anchorAlbumTracks(albumId, match.releaseMbid);

  return {
    albumId,
    releaseMbid: match.releaseMbid,
    matchedBy: match.matchedBy,
    reason: null,
    requests,
    release,
    anchors,
  };
}

/**
 * Albums whose MusicBrainz side is not yet cached.
 *
 * Two kinds, and the cheap kind comes first. An album whose release we already
 * know costs one request to cache; an album with no release yet costs a search
 * and a fetch per candidate and may still come to nothing. Draining the cheap
 * ones first means a run that is interrupted has spent its budget on the work
 * most likely to have paid off.
 *
 * Within the second kind, never-checked albums come before ones already looked
 * at, and the oldest check comes round again after that — MusicBrainz grows,
 * and an album absent last month may be there now, possibly because we added
 * it.
 */
export async function albumsNeedingIngest(limit = 25): Promise<string[]> {
  const rows = await db
    .select({ spotifyId: spotifyAlbum.spotifyId })
    .from(spotifyAlbum)
    .where(
      sql`not exists (select 1 from ${mbRelease} where ${mbRelease.mbid} = ${spotifyAlbum.mbReleaseId})`,
    )
    .orderBy(
      sql`${spotifyAlbum.mbReleaseId} is null`,
      sql`${spotifyAlbum.mbCheckedAt} is not null`,
      spotifyAlbum.mbCheckedAt,
    )
    .limit(limit);
  return rows.map((row) => row.spotifyId);
}

/**
 * Albums whose release is cached and whose tracks can be anchored.
 *
 * `includeAnchored` re-anchors albums that already have anchors, which is what
 * a change to the matching rules needs: anchoring costs no requests, so
 * re-running it over everything is cheap and is the only way a rule change
 * reaches rows decided under the old rule.
 */
export async function albumsNeedingAnchoring(
  limit = 100,
  includeAnchored = false,
): Promise<{ albumId: string; releaseMbid: string }[]> {
  const unanchored = sql`not exists (
    select 1 from ${trackRecording}
    join ${spotifyTrack} on ${spotifyTrack.spotifyId} = ${trackRecording.spotifyTrackId}
    where ${spotifyTrack.spotifyAlbumId} = ${spotifyAlbum.spotifyId}
  )`;

  const rows = await db
    .select({ albumId: spotifyAlbum.spotifyId, releaseMbid: spotifyAlbum.mbReleaseId })
    .from(spotifyAlbum)
    .where(
      and(
        isNotNull(spotifyAlbum.mbReleaseId),
        sql`exists (select 1 from ${mbReleaseTrack} where ${mbReleaseTrack.releaseMbid} = ${spotifyAlbum.mbReleaseId})`,
        includeAnchored ? undefined : unanchored,
      ),
    )
    .limit(limit);
  return rows.flatMap((row) => (row.releaseMbid ? [{ ...row, releaseMbid: row.releaseMbid }] : []));
}
