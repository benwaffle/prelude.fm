'use server';

import { and, eq, sql, type SQL } from 'drizzle-orm';
import { mbSubmission } from '@/lib/db/schema';
import { barcodeGaps } from '@/lib/gaps/barcodes';
import { contestedIsrcs } from '@/lib/gaps/contested';
import { isrcBatchGaps, isrcEligibleGaps } from '@/lib/gaps/isrc';
import { misalignedAlbums } from '@/lib/gaps/misaligned';
import { streamingUrlGaps } from '@/lib/gaps/streaming-urls';
import { withWorkCandidates, workRelationshipGaps } from '@/lib/gaps/work-relationships';
import { normalizeIsrc } from '@/lib/isrc';
import {
  barcodeSubmissionDraft,
  errorReportDraftFromContested,
  errorReportDraftFromMisaligned,
  isrcSubmissionDraft,
  ManualSubmissionError,
  requireMbid,
  streamingUrlDraft,
  workCreationDraftFromGap,
  workRelationshipDraftFromGap,
} from '@/lib/musicbrainz-manual-submissions';
import type { SubmissionDraft } from '@/lib/submission-evidence';
import { insertSubmissions } from '@/lib/submission-ledger';
import { recheckLedgerRows } from '../lib/submission-recheck';
import { checkAuth } from './auth';
import type { IsrcResubmission } from './bot';

type ConfirmOptions = { note?: string; editId?: string };

type Session = Awaited<ReturnType<typeof checkAuth>>;

// Written on confirm, not on opening a link. Outcome stays `pending`: MusicBrainz edits are voted
// on.
async function recordConfirmed(
  session: Session,
  drafts: SubmissionDraft[],
  options: ConfirmOptions,
) {
  await insertSubmissions(drafts, {
    submittedBy: `human:${session.user.name}`,
    note: options.note,
    editId: options.editId,
  });
}

export async function recordIsrcSubmission(
  releaseMbid: string,
  options: ConfirmOptions = {},
): Promise<void> {
  const session = await checkAuth();
  // A rejected ISRC is only recorded through its own row.
  const gaps = await isrcBatchGaps({ releaseMbids: [releaseMbid] });
  if (gaps.length === 0) throw new Error('That release has no outstanding ISRCs');
  await recordConfirmed(session, gaps.map(isrcSubmissionDraft), options);
}

/** The rejected row stays as history beside the new pending one. */
export async function recordIsrcResubmission(
  releaseMbid: string,
  resubmit: IsrcResubmission,
  options: ConfirmOptions = {},
): Promise<void> {
  const session = await checkAuth();
  const isrc = normalizeIsrc(resubmit.isrc);
  const gap = (await isrcEligibleGaps({ releaseMbids: [releaseMbid] })).find(
    (candidate) =>
      candidate.recordingMbid === resubmit.recordingMbid && normalizeIsrc(candidate.isrc) === isrc,
  );
  if (!gap) throw new ManualSubmissionError('That ISRC is not outstanding on this release');
  await recordConfirmed(session, [isrcSubmissionDraft(gap)], options);
}

export async function recordBarcodeSubmission(
  releaseMbid: string,
  options: ConfirmOptions = {},
): Promise<void> {
  const session = await checkAuth();
  const [gap] = await barcodeGaps({ releaseMbids: [releaseMbid] });
  if (!gap) {
    throw new ManualSubmissionError('That release has no outstanding barcode contribution');
  }
  await recordConfirmed(session, [barcodeSubmissionDraft(gap)], options);
}

async function workRelationshipGap(recordingMbid: string) {
  const recording = requireMbid(recordingMbid, 'The recording');
  const [gap] = await workRelationshipGaps({ recordingMbids: [recording] });
  if (!gap) {
    throw new ManualSubmissionError('That recording has no outstanding work relationship');
  }
  return gap;
}

export async function recordWorkRelationshipSubmission(
  recordingMbid: string,
  workMbid: string,
  options: ConfirmOptions = {},
): Promise<void> {
  const session = await checkAuth();
  const [gap] = await withWorkCandidates([await workRelationshipGap(recordingMbid)]);
  await recordConfirmed(session, [workRelationshipDraftFromGap(gap, workMbid)], options);
}

export async function recordWorkCreationSubmission(
  recordingMbid: string,
  workMbid: string,
  options: ConfirmOptions & { localWorkId?: number } = {},
): Promise<void> {
  const session = await checkAuth();
  const gap = await workRelationshipGap(recordingMbid);
  await recordConfirmed(
    session,
    [workCreationDraftFromGap(gap, workMbid, options.localWorkId)],
    options,
  );
}

export async function recordStreamingUrlSubmission(
  releaseMbid: string,
  albumId: string,
  options: ConfirmOptions = {},
): Promise<void> {
  const session = await checkAuth();
  const release = requireMbid(releaseMbid, 'The release');
  const gap = (await streamingUrlGaps({ releaseMbids: [release] })).find(
    (candidate) => candidate.albumId === albumId,
  );
  if (!gap) {
    throw new ManualSubmissionError(
      'That release is not a known-fetched streaming-URL contribution',
    );
  }
  await recordConfirmed(session, [streamingUrlDraft(gap)], options);
}

// Does not change cached MusicBrainz facts: the contradiction stays visible until a recheck sees it
// fixed upstream.
export async function recordContestedIsrcReport(
  isrc: string,
  disposition: string,
  options: ConfirmOptions = {},
): Promise<void> {
  const session = await checkAuth();
  const [gap] = await contestedIsrcs({ isrcs: [isrc] });
  if (!gap) {
    throw new ManualSubmissionError('That ISRC is not currently contested in the cache');
  }
  await recordConfirmed(session, [errorReportDraftFromContested(gap, disposition)], options);
}

/** The cache is left as MusicBrainz stated it. */
export async function recordMisalignedTracklistReport(
  albumId: string,
  disposition: string,
  options: ConfirmOptions = {},
): Promise<void> {
  const session = await checkAuth();
  const [gap] = await misalignedAlbums({ albumIds: [albumId] });
  if (!gap) {
    throw new ManualSubmissionError('That album is not currently a misaligned tracklist');
  }
  await recordConfirmed(session, [errorReportDraftFromMisaligned(gap, disposition)], options);
}

export type RecheckTarget =
  | { kind: 'isrc'; releaseMbid: string }
  | { kind: 'barcode' | 'streaming_url'; releaseMbid: string }
  | { kind: 'work_relationship'; recordingMbid: string; workMbid: string }
  | { kind: 'work'; workMbid: string }
  | { kind: 'release'; albumId: string }
  | { kind: 'error'; value: string };

function recheckWhere(target: RecheckTarget): SQL | undefined {
  const kind = eq(mbSubmission.kind, target.kind);
  switch (target.kind) {
    case 'isrc':
      return and(
        kind,
        sql`json_extract(${mbSubmission.evidence}, '$.releaseMbid') = ${requireMbid(target.releaseMbid, 'The release')}`,
      );
    case 'barcode':
    case 'streaming_url':
      return and(kind, eq(mbSubmission.targetMbid, requireMbid(target.releaseMbid, 'The release')));
    case 'work_relationship':
      return and(
        kind,
        eq(mbSubmission.targetMbid, requireMbid(target.recordingMbid, 'The recording')),
        eq(mbSubmission.value, requireMbid(target.workMbid, 'The work')),
      );
    case 'work':
      return and(kind, eq(mbSubmission.targetMbid, requireMbid(target.workMbid, 'The work')));
    case 'release':
      return and(kind, eq(mbSubmission.subject, target.albumId));
    case 'error':
      return and(kind, eq(mbSubmission.value, target.value));
  }
}

/** Submits nothing; a still-missing edit stays pending. */
export async function recheckSubmission(
  target: RecheckTarget,
): Promise<{ applied: number; landed: boolean }> {
  await checkAuth();
  const result = await recheckLedgerRows(recheckWhere(target));
  if (!result) throw new ManualSubmissionError('There is no confirmation of that to recheck');
  return { applied: result.applied, landed: result.landed.size > 0 };
}

/** Unfetched streaming URL relations stay pending rather than counting as landed. */
export async function reconcileSubmissions(): Promise<{
  checked: number;
  targets: number;
  requests: number;
  applied: number;
}> {
  await checkAuth();
  const result = await recheckLedgerRows(eq(mbSubmission.outcome, 'pending'));
  if (!result) return { checked: 0, targets: 0, requests: 0, applied: 0 };
  const { checked, targets, requests, applied } = result;
  return { checked, targets, requests, applied };
}
