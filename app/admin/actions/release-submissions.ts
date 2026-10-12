'use server';

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mbMissingRelease, mbSubmission, spotifyAlbum } from '@/lib/db/schema';
import { missingReleases } from '@/lib/gaps/missing-releases';
import { musicBrainzApi } from '@/lib/musicbrainz';
import {
  ManualSubmissionError,
  releaseSubmissionDraftFromGap,
  requireMbid,
} from '@/lib/musicbrainz-manual-submissions';
import {
  mbApiReleaseToPickHit,
  normalisePickBarcode,
  type MbPickHit,
  type PickedReleaseAttachRequest,
} from '@/lib/musicbrainz-pick';
import { adoptReleaseForAlbum } from '@/lib/musicbrainz-submission-pull';
import {
  cachedReleasePrechecks,
  refreshReleasePrecheck,
  type CachedPrecheck,
} from '@/lib/release-precheck-run';
import {
  markReleaseSeeded,
  prepareReleaseSeed,
  type PreparedSeed,
} from '@/lib/release-seeding-run';
import {
  correctionRecords,
  measureReleaseCorrection,
  type CorrectionRow,
} from '@/lib/release-corrections-run';
import {
  summariseCorrections,
  type CorrectionSummaryRow,
  type ReleaseCorrectionRecord,
} from '@/lib/release-corrections';
import { insertSubmissions, readLedger } from '@/lib/submission-ledger';
import { recheckLedgerRows } from '../lib/submission-recheck';
import { checkAuth } from './auth';

/** Reads only: does not ingest, write the album's matched release, or write the ledger. */
export async function lookupBarcodeReleaseHits(upc: string): Promise<{
  hits: MbPickHit[];
  error: string | null;
}> {
  await checkAuth();
  const barcode = normalisePickBarcode(upc);
  if (!barcode) return { hits: [], error: 'That album has no barcode to search with' };

  try {
    const source = musicBrainzApi('interactive');
    const ids = await source.releasesByBarcode(barcode);
    const hits: MbPickHit[] = [];
    for (const id of ids.slice(0, 8)) {
      const release = await source.releaseWithRecordings(id);
      if (release) hits.push(mbApiReleaseToPickHit(release));
    }
    hits.sort((a, b) => a.title.localeCompare(b.title) || a.mbid.localeCompare(b.mbid));
    return { hits, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { hits: [], error: message };
  }
}

export async function attachPickedReleaseToAlbum(request: PickedReleaseAttachRequest) {
  await checkAuth();
  return adoptReleaseForAlbum(
    musicBrainzApi('interactive'),
    request.albumId,
    requireMbid(request.releaseMbid, 'The release'),
  );
}

/** Recorded only after the editor confirms the external edit. */
export async function recordReleaseSubmission(
  albumId: string,
  options: { note?: string; editId?: string; releaseMbid?: string } = {},
): Promise<{ landed: boolean }> {
  const session = await checkAuth();
  const [gap] = await missingReleases({ albumIds: [albumId] });
  if (!gap) {
    throw new ManualSubmissionError('That album is not a missing-release contribution');
  }

  const draft = releaseSubmissionDraftFromGap(gap, options.releaseMbid);
  await insertSubmissions([draft], {
    submittedBy: `human:${session.user.name}`,
    note: options.note,
    editId: options.editId,
  });
  if (!draft.evidence.releaseMbid) return { landed: false };
  const result = await recheckLedgerRows(
    and(eq(mbSubmission.kind, 'release'), eq(mbSubmission.subject, albumId)),
  );
  return { landed: (result?.landed.size ?? 0) > 0 };
}

export async function runReleasePrecheck(albumId: string): Promise<CachedPrecheck> {
  await checkAuth();
  await refreshReleasePrecheck(albumId);
  const cached = (await cachedReleasePrechecks([albumId])).get(albumId);
  if (!cached) throw new Error('The pre-check ran but was not stored');
  return cached;
}

/** Submits nothing. */
export async function prepareMusicBrainzSeed(albumId: string): Promise<PreparedSeed> {
  await checkAuth();
  return prepareReleaseSeed(albumId);
}

export async function recordMusicBrainzSeeded(albumId: string): Promise<void> {
  await checkAuth();
  await markReleaseSeeded(albumId);
}

/** Reads MusicBrainz; submits nothing. */
export async function measureReleaseCorrections(albumId: string): Promise<ReleaseCorrectionRecord> {
  await checkAuth();
  const [latest] = (
    await readLedger(and(eq(mbSubmission.kind, 'release'), eq(mbSubmission.subject, albumId)))
  ).slice(-1);
  const releaseMbid = latest?.evidence.kind === 'release' ? latest.evidence.releaseMbid : null;
  return measureReleaseCorrection(albumId, releaseMbid);
}

export type ReleaseCorrectionsView = {
  rows: CorrectionRow[];
  summary: CorrectionSummaryRow[];
  unmeasured: { albumId: string; albumTitle: string; releaseMbid: string | null }[];
};

export async function getReleaseCorrections(): Promise<ReleaseCorrectionsView> {
  await checkAuth();
  const [rows, unmeasured] = await Promise.all([
    correctionRecords(),
    db
      .select({
        albumId: spotifyAlbum.spotifyId,
        albumTitle: spotifyAlbum.title,
        releaseMbid: spotifyAlbum.mbReleaseId,
      })
      .from(mbSubmission)
      .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, mbSubmission.subject))
      .leftJoin(
        mbMissingRelease,
        and(
          eq(mbMissingRelease.spotifyAlbumId, spotifyAlbum.spotifyId),
          eq(mbMissingRelease.stage, 'correction'),
        ),
      )
      .where(
        and(
          eq(mbSubmission.kind, 'release'),
          inArray(mbSubmission.outcome, ['pending', 'applied']),
          isNotNull(spotifyAlbum.mbReleaseId),
          isNull(mbMissingRelease.spotifyAlbumId),
        ),
      )
      .groupBy(spotifyAlbum.spotifyId),
  ]);
  return {
    rows,
    summary: summariseCorrections(rows.map((row) => row.record)),
    unmeasured,
  };
}
