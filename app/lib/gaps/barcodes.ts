import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  mbRecording,
  mbRelease,
  mbReleaseTrack,
  mbSubmission,
  spotifyAlbum,
  spotifyTrack,
} from '../db/schema';
import { filmScoreExclusions } from '../film-score-exclusions';
import {
  verifyBarcodeRelease,
  type MusicBrainzBarcodeEvidence,
  type SpotifyBarcodeEvidence,
} from '../musicbrainz-contribution-safety';
import { BATCH_BLOCKING_OUTCOMES, BLOCKING_OUTCOMES } from '../musicbrainz-manual-submissions';
import { within, without } from './scope';

/**
 * Releases MusicBrainz holds without a barcode, where Spotify gives us one.
 *
 * Small, because a release is usually found *by* its barcode in the first
 * place — these are the ones matched on title and duration instead.
 *
 * A submitted barcode stays listed until the cache holds one. Hiding it on
 * confirm would look like MusicBrainz had accepted an edit that is still a
 * proposal.
 */
export type BarcodeGap = {
  releaseMbid: string;
  releaseTitle: string;
  albumId: string;
  barcode: string;
  trackCount: number;
  maxDurationDeltaMs: number;
};

/** Narrow a barcode list to some releases, for one release's own action. */
export type BarcodeGapScope = { releaseMbids?: readonly string[] };

export async function barcodeGaps(scope: BarcodeGapScope = {}): Promise<BarcodeGap[]> {
  const film = await filmScoreExclusions();
  const candidates = await db
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
        within(mbRelease.mbid, scope.releaseMbids),
        without(spotifyAlbum.spotifyId, film.albumIds),
        sql`${mbRelease.barcode} is null or ${mbRelease.barcode} = ''`,
        sql`${spotifyAlbum.upc} is not null and ${spotifyAlbum.upc} <> ''`,
      ),
    );
  if (candidates.length === 0) return [];

  const albumIds = [...new Set(candidates.map((candidate) => candidate.albumId))];
  const releaseMbids = [...new Set(candidates.map((candidate) => candidate.releaseMbid))];
  const [spotifyRows, musicbrainzRows] = await Promise.all([
    db
      .select({
        albumId: spotifyAlbum.spotifyId,
        albumTitle: spotifyAlbum.title,
        discNumber: spotifyTrack.discNumber,
        trackNumber: spotifyTrack.trackNumber,
        durationMs: spotifyTrack.durationMs,
      })
      .from(spotifyAlbum)
      .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyAlbumId, spotifyAlbum.spotifyId))
      .where(inArray(spotifyAlbum.spotifyId, albumIds)),
    db
      .select({
        releaseMbid: mbRelease.mbid,
        releaseTitle: mbRelease.title,
        medium: mbReleaseTrack.medium,
        position: mbReleaseTrack.position,
        durationMs: sql<number | null>`coalesce(${mbReleaseTrack.length}, ${mbRecording.length})`,
      })
      .from(mbRelease)
      .innerJoin(mbReleaseTrack, eq(mbReleaseTrack.releaseMbid, mbRelease.mbid))
      .innerJoin(mbRecording, eq(mbRecording.mbid, mbReleaseTrack.recordingMbid))
      .where(inArray(mbRelease.mbid, releaseMbids)),
  ]);

  const spotifyByAlbum = new Map<string, SpotifyBarcodeEvidence[]>();
  for (const row of spotifyRows) {
    const rows = spotifyByAlbum.get(row.albumId) ?? [];
    rows.push(row);
    spotifyByAlbum.set(row.albumId, rows);
  }
  const musicbrainzByRelease = new Map<string, MusicBrainzBarcodeEvidence[]>();
  for (const row of musicbrainzRows) {
    const rows = musicbrainzByRelease.get(row.releaseMbid) ?? [];
    rows.push(row);
    musicbrainzByRelease.set(row.releaseMbid, rows);
  }

  return candidates
    .flatMap((candidate) => {
      const verification = verifyBarcodeRelease(
        spotifyByAlbum.get(candidate.albumId) ?? [],
        musicbrainzByRelease.get(candidate.releaseMbid) ?? [],
      );
      return verification ? [{ ...candidate, ...verification }] : [];
    })
    .sort(
      (a, b) =>
        a.releaseTitle.localeCompare(b.releaseTitle) || a.releaseMbid.localeCompare(b.releaseMbid),
    );
}

/**
 * Barcode gaps with no submission in hand (pending or applied).
 *
 * The displayed list is `barcodeGaps`, which keeps pending ledger rows visible.
 * The bot only receives rows from this set. With `batch`, releases whose
 * barcode edit was rejected before are left out too: those go again only
 * when their own row asks.
 */
export async function barcodeEligibleGaps({
  batch = false,
  ...scope
}: BarcodeGapScope & { batch?: boolean } = {}): Promise<BarcodeGap[]> {
  const gaps = await barcodeGaps(scope);
  if (gaps.length === 0) return [];

  const releaseMbids = [...new Set(gaps.map((gap) => gap.releaseMbid))];
  const ledgerRows = await db
    .select({
      targetMbid: mbSubmission.targetMbid,
      value: mbSubmission.value,
    })
    .from(mbSubmission)
    .where(
      and(
        eq(mbSubmission.kind, 'barcode'),
        inArray(mbSubmission.targetMbid, releaseMbids),
        inArray(
          mbSubmission.outcome,
          batch ? [...BATCH_BLOCKING_OUTCOMES] : [...BLOCKING_OUTCOMES],
        ),
      ),
    );

  const ledgered = new Set(ledgerRows.map((row) => `${row.targetMbid}\u0000${row.value ?? ''}`));

  return gaps.filter((gap) => !ledgered.has(`${gap.releaseMbid}\u0000${gap.barcode}`));
}
