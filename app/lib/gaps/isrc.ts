/**
 * What we know that MusicBrainz does not.
 *
 * Every gap under `gaps/` is a contribution waiting to be made. The cache
 * makes them ordinary queries rather than searches: once an album's release
 * is cached and its tracks are anchored, "this recording has no ISRC and we
 * hold one" is a join.
 *
 * Each gap module returns the whole list; the Inbox derives its count and its
 * page from that one read, and a single-row action narrows the same query to
 * its own key rather than reading everything and searching it.
 *
 * The standard for submitting is deliberately stricter than the standard for
 * anchoring, and the difference is the whole point of these files. Anchoring
 * is a belief about our own library, and being wrong costs us a mismatched
 * track. Submitting is a claim on a database other people rely on, and being
 * wrong costs *them* — a bad ISRC is how Haydn's Symphony 87 lost its link.
 * So a track can be confidently anchored and still not be evidence enough to
 * submit.
 */
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
import { within, without } from './scope';

export type { IsrcGap } from '../musicbrainz-edit-links';

/** Narrow an ISRC list to some releases, for one release's own action. */
export type IsrcGapScope = { releaseMbids?: readonly string[] };

/**
 * Recordings we can name an ISRC for that MusicBrainz does not have one for.
 *
 * The conditions are the evidence, stated as a query:
 *
 * - the album's barcode is exactly the release's, so this really is the
 *   record the label pressed;
 * - the complete Spotify album and MusicBrainz release have identical track
 *   counts (or every repeated hybrid layer does), and every track maps
 *   one-to-one by anchored recording with its duration agreeing within three
 *   seconds;
 * - MusicBrainz holds no ISRC for that recording yet.
 *
 * Tracks anchored *by* ISRC are absent by construction: if the ISRC resolved
 * the recording, MusicBrainz already had it. Already-ledgered rows stay in
 * this list until the cache holds the ISRC; bot and MagicISRC eligibility
 * is `isrcEligibleGaps`, which excludes them.
 */
export async function isrcGaps(scope: IsrcGapScope = {}): Promise<IsrcGap[]> {
  return verifiedIsrcGaps(await isrcGapRows('all', scope));
}

/**
 * Cache gaps with no submission in hand (pending or applied).
 *
 * Includes gaps whose earlier submission was rejected or withdrawn: those
 * are offered again. The displayed list is `isrcGaps`, which keeps pending
 * ledger rows visible.
 */
export async function isrcEligibleGaps(scope: IsrcGapScope = {}): Promise<IsrcGap[]> {
  return verifiedIsrcGaps(await isrcGapRows('eligible', scope));
}

/**
 * What a release's batch may carry: eligible gaps minus those MusicBrainz
 * voters rejected before. The bot, MagicISRC links and hand-confirm send
 * this set; a rejected gap goes again only through its own per-row click.
 */
export async function isrcBatchGaps(scope: IsrcGapScope = {}): Promise<IsrcGap[]> {
  return verifiedIsrcGaps(await isrcGapRows('batch', scope));
}

/**
 * One row per recording, not per position it occupies.
 *
 * A hybrid SACD is three mediums in MusicBrainz — a CD layer and two SACD
 * layers — listing the same recordings on each, so a join through the
 * tracklist returns every ISRC three times. Left alone that inflates the
 * count on the button, and spends the bot's per-album allowance on the same
 * edit repeatedly.
 *
 * The earliest position wins, which for a hybrid disc is the CD layer.
 */
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
  const film = await filmScoreExclusions();
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
        without(spotifyTrack.spotifyId, film.trackIds),
        sql`${spotifyTrack.isrc} is not null`,
        // The barcode must be the release's own, ignoring the zero padding
        // that distinguishes a UPC-12 from the same EAN-13.
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

/** Gaps grouped by release, the releases missing most first. */
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
