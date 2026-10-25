// Submitting is held to a stricter standard than anchoring: a wrong anchor costs us a track, a
// wrong submission costs other MusicBrainz users (a bad ISRC is how Haydn's Symphony 87 lost its
// link).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  mbRecording,
  mbRecordingIsrc,
  mbRelease,
  mbReleaseTrack,
  mbSubmission,
  spotifyAlbum,
  spotifyTrack,
  trackRecording,
} from '../db/schema';
import { filmScoreExclusions } from '../film-score-exclusions';
import type { IsrcGap } from '../musicbrainz-edit-links';
import {
  ISRC_SUBMISSION_TOLERANCE_MS,
  releaseMediumKey,
  verifiedIsrcReleaseMedia,
  type MusicBrainzReleaseEvidence,
  type SpotifyReleaseEvidence,
} from '../musicbrainz-contribution-safety';
import { BATCH_BLOCKING_OUTCOMES, BLOCKING_OUTCOMES } from '../musicbrainz-manual-submissions';
import { albumsOfReleases, within, without } from './scope';

export type { IsrcGap } from '../musicbrainz-edit-links';

export type IsrcGapScope = { releaseMbids?: readonly string[]; albumIds?: readonly string[] };

// Evidence: barcode matches exactly, full tracklists map one-to-one with durations within 3s, and
// MusicBrainz has no ISRC yet. Ledgered rows stay listed until the cache holds the ISRC;
// `isrcEligibleGaps` excludes them.
export async function isrcGaps(scope: IsrcGapScope = {}): Promise<IsrcGap[]> {
  return verifiedIsrcGaps(await isrcGapRows('all', scope));
}

/** Includes gaps whose earlier submission was rejected or withdrawn: those are offered again. */
export async function isrcEligibleGaps(scope: IsrcGapScope = {}): Promise<IsrcGap[]> {
  return verifiedIsrcGaps(await isrcGapRows('eligible', scope));
}

// Minus those voters rejected before; a rejected gap goes again only through its own row's click.
export async function isrcBatchGaps(scope: IsrcGapScope = {}): Promise<IsrcGap[]> {
  return verifiedIsrcGaps(await isrcGapRows('batch', scope));
}

// A hybrid SACD lists the same recordings on three mediums; keep the earliest (CD layer) so counts
// and bot allowance aren't tripled.
function dedupeByRecording(rows: IsrcGap[]): IsrcGap[] {
  const byPair = new Map<string, IsrcGap>();
  for (const row of rows) {
    const key = `${row.recordingMbid}:${row.isrc}`;
    const seen = byPair.get(key);
    if (
      !seen ||
      row.medium < seen.medium ||
      (row.medium === seen.medium && row.position < seen.position)
    ) {
      byPair.set(key, row);
    }
  }
  return [...byPair.values()];
}

async function verifiedIsrcGaps(candidates: IsrcGap[]): Promise<IsrcGap[]> {
  if (candidates.length === 0) return [];

  const albumIds = [...new Set(candidates.map((row) => row.albumId))];
  const releaseMbids = [...new Set(candidates.map((row) => row.releaseMbid))];
  const [spotifyEvidence, musicbrainzEvidence] = await Promise.all([
    spotifyReleaseEvidence(albumIds),
    musicbrainzReleaseEvidence(releaseMbids),
  ]);
  const verified = verifiedIsrcReleaseMedia(spotifyEvidence, musicbrainzEvidence);

  return dedupeByRecording(
    candidates.filter((gap) =>
      verified.has(releaseMediumKey(gap.albumId, gap.releaseMbid, gap.medium)),
    ),
  );
}

async function isrcGapRows(
  ledger: 'all' | 'eligible' | 'batch',
  scope: IsrcGapScope,
): Promise<IsrcGap[]> {
  const film = await filmScoreExclusions(scope.albumIds ?? albumsOfReleases(scope.releaseMbids));
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
        within(mbRelease.mbid, scope.releaseMbids),
        within(spotifyAlbum.spotifyId, scope.albumIds),
        without(spotifyTrack.spotifyId, film.trackIds),
        sql`${spotifyTrack.isrc} is not null`,
        // Ignore the zero padding that distinguishes a UPC-12 from the same EAN-13.
        sql`ltrim(coalesce(${spotifyAlbum.upc}, ''), '0') = ltrim(coalesce(${mbRelease.barcode}, ''), '0')`,
        sql`ltrim(coalesce(${spotifyAlbum.upc}, ''), '0') <> ''`,
        sql`coalesce(${mbReleaseTrack.length}, ${mbRecording.length}) is not null`,
        sql`${delta} <= ${ISRC_SUBMISSION_TOLERANCE_MS}`,
        sql`not exists (
          select 1 from ${mbRecordingIsrc}
          where ${mbRecordingIsrc.recordingMbid} = ${trackRecording.recordingMbid}
            and ${mbRecordingIsrc.isrc} = ${spotifyTrack.isrc}
        )`,
        ledger === 'all'
          ? undefined
          : sql`not exists (
              select 1 from ${mbSubmission}
              where ${mbSubmission.kind} = 'isrc'
                and ${mbSubmission.targetMbid} = ${trackRecording.recordingMbid}
                and ${mbSubmission.value} = ${spotifyTrack.isrc}
                and ${inArray(mbSubmission.outcome, ledger === 'batch' ? [...BATCH_BLOCKING_OUTCOMES] : [...BLOCKING_OUTCOMES])}
            )`,
      ),
    );
}

async function spotifyReleaseEvidence(albumIds: string[]): Promise<SpotifyReleaseEvidence[]> {
  const rows = await db
    .select({
      albumId: spotifyAlbum.spotifyId,
      releaseMbid: spotifyAlbum.mbReleaseId,
      upc: spotifyAlbum.upc,
      spotifyTrackId: spotifyTrack.spotifyId,
      recordingMbid: trackRecording.recordingMbid,
      durationMs: spotifyTrack.durationMs,
    })
    .from(spotifyTrack)
    .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
    .leftJoin(trackRecording, eq(trackRecording.spotifyTrackId, spotifyTrack.spotifyId))
    .where(inArray(spotifyAlbum.spotifyId, albumIds));

  return rows.flatMap((row) =>
    row.releaseMbid === null ? [] : [{ ...row, releaseMbid: row.releaseMbid }],
  );
}

async function musicbrainzReleaseEvidence(
  releaseMbids: string[],
): Promise<MusicBrainzReleaseEvidence[]> {
  return db
    .select({
      releaseMbid: mbReleaseTrack.releaseMbid,
      barcode: mbRelease.barcode,
      medium: mbReleaseTrack.medium,
      position: mbReleaseTrack.position,
      recordingMbid: mbReleaseTrack.recordingMbid,
      durationMs: sql<number | null>`coalesce(${mbReleaseTrack.length}, ${mbRecording.length})`,
    })
    .from(mbReleaseTrack)
    .innerJoin(mbRelease, eq(mbRelease.mbid, mbReleaseTrack.releaseMbid))
    .innerJoin(mbRecording, eq(mbRecording.mbid, mbReleaseTrack.recordingMbid))
    .where(inArray(mbReleaseTrack.releaseMbid, releaseMbids));
}

/** Grouped by release because MagicISRC takes a release and a set of positions. */
export type IsrcGapRelease = {
  releaseMbid: string;
  albumId: string;
  albumTitle: string;
  missing: number;
  gaps: IsrcGap[];
};

export function isrcGapReleases(gaps: IsrcGap[]): IsrcGapRelease[] {
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
  return [...byRelease.values()].sort(
    (a, b) => b.missing - a.missing || a.releaseMbid.localeCompare(b.releaseMbid),
  );
}
