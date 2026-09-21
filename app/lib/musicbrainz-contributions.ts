/**
 * What we know that MusicBrainz does not.
 *
 * Every gap here is a contribution waiting to be made. The cache makes them
 * ordinary queries rather than searches: once an album's release is cached
 * and its tracks are anchored, "this recording has no ISRC and we hold one"
 * is a join.
 *
 * The standard for submitting is deliberately stricter than the standard for
 * anchoring, and the difference is the whole point of this file. Anchoring is
 * a belief about our own library, and being wrong costs us a mismatched
 * track. Submitting is a claim on a database other people rely on, and being
 * wrong costs *them* — a bad ISRC is how Haydn's Symphony 87 lost its link.
 * So a track can be confidently anchored and still not be evidence enough to
 * submit.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from './db';
import type { IsrcGap } from './musicbrainz-edit-links';
import {
  mbRecording,
  mbRecordingIsrc,
  mbRelease,
  mbReleaseTrack,
  mbSubmission,
  spotifyAlbum,
  spotifyTrack,
  trackRecording,
} from './db/schema';

/**
 * How closely a duration must agree before we will tell MusicBrainz an ISRC
 * belongs to a recording.
 *
 * Three seconds — the standard already used for ISRC submissions here, and
 * tighter than the fifteen that anchoring allows on an aligned tracklist. A
 * track can be confidently ours and still not be proof enough for somebody
 * else's database.
 */
const SUBMISSION_TOLERANCE_MS = 3_000;

export type { IsrcGap } from './musicbrainz-edit-links';
export {
  harmonyImportLink,
  magicIsrcLink,
  recordingEditLink,
  releaseEditLink,
} from './musicbrainz-edit-links';

/**
 * Recordings we can name an ISRC for that MusicBrainz does not have one for.
 *
 * The conditions are the evidence, stated as a query:
 *
 * - the album's barcode is exactly the release's, so this really is the
 *   record the label pressed;
 * - the track sits at a position on that release whose duration agrees within
 *   three seconds, so it really is this recording;
 * - MusicBrainz holds no ISRC for that recording yet; and
 * - we have not already submitted this one, whoever submitted it.
 *
 * Tracks anchored *by* ISRC are absent by construction: if the ISRC resolved
 * the recording, MusicBrainz already had it.
 */
export async function isrcGaps(limit = 200): Promise<IsrcGap[]> {
  const delta = sql<number>`abs(coalesce(${mbReleaseTrack.length}, ${mbRecording.length}) - ${spotifyTrack.durationMs})`;

  return db
    .select({
      spotifyTrackId: spotifyTrack.spotifyId,
      trackTitle: spotifyTrack.title,
      albumId: spotifyAlbum.spotifyId,
      albumTitle: spotifyAlbum.title,
      isrc: sql<string>`${spotifyTrack.isrc}`,
      recordingMbid: trackRecording.recordingMbid,
      recordingTitle: mbRecording.title,
      releaseMbid: mbRelease.mbid,
      barcode: mbRelease.barcode,
      upc: sql<string | null>`${spotifyAlbum.upc}`,
      medium: mbReleaseTrack.medium,
      position: mbReleaseTrack.position,
      durationDeltaMs: delta,
      matchedBy: trackRecording.matchedBy,
    })
    .from(trackRecording)
    .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId))
    .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
    .innerJoin(mbRelease, eq(mbRelease.mbid, spotifyAlbum.mbReleaseId))
    .innerJoin(mbRecording, eq(mbRecording.mbid, trackRecording.recordingMbid))
    .innerJoin(
      mbReleaseTrack,
      and(
        eq(mbReleaseTrack.releaseMbid, mbRelease.mbid),
        eq(mbReleaseTrack.recordingMbid, trackRecording.recordingMbid),
      ),
    )
    .where(
      and(
        sql`${spotifyTrack.isrc} is not null`,
        // The barcode must be the release's own, ignoring the zero padding
        // that distinguishes a UPC-12 from the same EAN-13.
        sql`ltrim(coalesce(${spotifyAlbum.upc}, ''), '0') = ltrim(coalesce(${mbRelease.barcode}, ''), '0')`,
        sql`ltrim(coalesce(${spotifyAlbum.upc}, ''), '0') <> ''`,
        sql`coalesce(${mbReleaseTrack.length}, ${mbRecording.length}) is not null`,
        sql`${delta} <= ${SUBMISSION_TOLERANCE_MS}`,
        sql`not exists (
          select 1 from ${mbRecordingIsrc}
          where ${mbRecordingIsrc.recordingMbid} = ${trackRecording.recordingMbid}
            and ${mbRecordingIsrc.isrc} = ${spotifyTrack.isrc}
        )`,
        sql`not exists (
          select 1 from ${mbSubmission}
          where ${mbSubmission.kind} = 'isrc'
            and ${mbSubmission.targetMbid} = ${trackRecording.recordingMbid}
            and ${mbSubmission.value} = ${spotifyTrack.isrc}
        )`,
      ),
    )
    .limit(limit);
}

/**
 * Releases MusicBrainz holds that carry no ISRC at all, with how many we
 * could supply.
 *
 * Grouped by release because that is how the submission is made: MagicISRC
 * takes a release and a set of positions, so one visit contributes every ISRC
 * an album is missing rather than one.
 */
export type IsrcGapRelease = {
  releaseMbid: string;
  albumId: string;
  albumTitle: string;
  missing: number;
  gaps: IsrcGap[];
};

export async function isrcGapsByRelease(limit = 100): Promise<IsrcGapRelease[]> {
  const gaps = await isrcGaps(2_000);
  const byRelease = new Map<string, IsrcGapRelease>();
  for (const gap of gaps) {
    const existing = byRelease.get(gap.releaseMbid);
    if (existing) {
      existing.missing++;
      existing.gaps.push(gap);
    } else {
      byRelease.set(gap.releaseMbid, {
        releaseMbid: gap.releaseMbid,
        albumId: gap.albumId,
        albumTitle: gap.albumTitle,
        missing: 1,
        gaps: [gap],
      });
    }
  }
  return [...byRelease.values()].sort((a, b) => b.missing - a.missing).slice(0, limit);
}

/**
 * Recordings MusicBrainz holds but has never linked to a work.
 *
 * The highest-value human class: we can find the recording and we can often
 * propose the work, because a sibling recording on the same release already
 * points at one. The human step is a confirmation rather than a search.
 */
export type WorkRelationshipGap = {
  recordingMbid: string;
  recordingTitle: string;
  /** Null when the album's release is not cached; the recording is still actionable. */
  releaseMbid: string | null;
  albumTitle: string;
  tracks: number;
};

export async function workRelationshipGaps(limit = 100): Promise<WorkRelationshipGap[]> {
  return db
    .select({
      recordingMbid: trackRecording.recordingMbid,
      recordingTitle: mbRecording.title,
      releaseMbid: mbRelease.mbid,
      albumTitle: spotifyAlbum.title,
      tracks: sql<number>`count(*)`,
    })
    .from(trackRecording)
    .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId))
    .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
    .innerJoin(mbRecording, eq(mbRecording.mbid, trackRecording.recordingMbid))
    .leftJoin(mbRelease, eq(mbRelease.mbid, spotifyAlbum.mbReleaseId))
    .where(
      sql`not exists (
        select 1 from mb_recording_work
        where mb_recording_work.recording_mbid = ${trackRecording.recordingMbid}
      )`,
    )
    .groupBy(trackRecording.recordingMbid)
    .limit(limit);
}

/**
 * ISRCs MusicBrainz maps to more than one recording.
 *
 * Not our gap but an upstream error, and one that costs us real links: a
 * label attached Sony's ISRC for Haydn's Symphony 87 to a recording of
 * Symphony 82, and our matcher could only refuse to choose. We find these, so
 * we can report them.
 */
export type ContestedIsrc = {
  isrc: string;
  recordings: number;
  titles: string;
};

export async function contestedIsrcs(limit = 100): Promise<ContestedIsrc[]> {
  return db
    .select({
      isrc: mbRecordingIsrc.isrc,
      recordings: sql<number>`count(*)`,
      titles: sql<string>`group_concat(${mbRecording.title}, ' / ')`,
    })
    .from(mbRecordingIsrc)
    .innerJoin(mbRecording, eq(mbRecording.mbid, mbRecordingIsrc.recordingMbid))
    .groupBy(mbRecordingIsrc.isrc)
    .having(sql`count(*) > 1`)
    .limit(limit);
}

/**
 * Albums MusicBrainz does not hold as a release.
 *
 * The largest remaining gap by a distance, and the one class that stays
 * human permanently: a duplicate release is expensive for other people to
 * merge away, and that cost is not ours to impose. Harmony seeds the form
 * from the Spotify album, so the human step is checking rather than typing.
 *
 * Ordered by how much of the library each would unlock, because adding a
 * thirty-track box set is worth more than adding a single.
 */
export type MissingRelease = {
  albumId: string;
  albumTitle: string;
  year: number | null;
  upc: string | null;
  tracks: number;
  /** Tracks still reaching no MusicBrainz recording at all. */
  unanchored: number;
  /** Why the lookup failed, as far as we know. */
  reason: string;
};

export async function missingReleases(limit = 60): Promise<MissingRelease[]> {
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
    .where(sql`${spotifyAlbum.mbReleaseId} is null`)
    .groupBy(spotifyAlbum.spotifyId)
    .orderBy(sql`count(distinct ${spotifyTrack.spotifyId}) desc`)
    .limit(limit);
}

/**
 * Releases MusicBrainz holds without a barcode, where Spotify gives us one.
 *
 * Small, because a release is usually found *by* its barcode in the first
 * place — these are the ones matched on title and duration instead.
 */
export type BarcodeGap = {
  releaseMbid: string;
  releaseTitle: string;
  albumId: string;
  barcode: string;
};

export async function barcodeGaps(limit = 50): Promise<BarcodeGap[]> {
  return db
    .select({
      releaseMbid: mbRelease.mbid,
      releaseTitle: mbRelease.title,
      albumId: spotifyAlbum.spotifyId,
      barcode: sql<string>`${spotifyAlbum.upc}`,
    })
    .from(spotifyAlbum)
    .innerJoin(mbRelease, eq(mbRelease.mbid, spotifyAlbum.mbReleaseId))
    .where(
      and(
        sql`${mbRelease.barcode} is null or ${mbRelease.barcode} = ''`,
        sql`${spotifyAlbum.upc} is not null and ${spotifyAlbum.upc} <> ''`,
        sql`not exists (
          select 1 from ${mbSubmission}
          where ${mbSubmission.kind} = 'barcode'
            and ${mbSubmission.targetMbid} = ${mbRelease.mbid}
        )`,
      ),
    )
    .limit(limit);
}

/** How much of each kind of contribution is waiting. */
export async function contributionCounts() {
  const [isrc, works, contested, missing, barcodes, submitted] = await Promise.all([
    isrcGaps(5_000).then((rows) => rows.length),
    workRelationshipGaps(5_000).then((rows) => rows.length),
    contestedIsrcs(5_000).then((rows) => rows.length),
    missingReleases(5_000).then((rows) => rows.length),
    barcodeGaps(5_000).then((rows) => rows.length),
    db
      .select({ outcome: mbSubmission.outcome, n: sql<number>`count(*)` })
      .from(mbSubmission)
      .groupBy(mbSubmission.outcome),
  ]);
  return {
    isrc,
    workRelationships: works,
    contestedIsrcs: contested,
    missingReleases: missing,
    barcodes,
    submissions: Object.fromEntries(submitted.map((row) => [row.outcome, row.n])),
  };
}
