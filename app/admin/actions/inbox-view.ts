'use server';

import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '@/lib/db';
import { forChunks } from '@/lib/db/chunked';
import { mbSubmission } from '@/lib/db/schema';
import {
  pageSlice,
  rankMissingReleases,
  resolveContributionLimits,
  type ContributionListLimits,
} from '@/lib/contribution-list';
import { countContributions, gapLists, submissionCounts } from '@/lib/gaps/counts';
import {
  judgeContestedIsrcs,
  type ContestedIsrc,
  type ContestedIsrcJudgement,
} from '@/lib/gaps/contested';
import { isrcGapReleases } from '@/lib/gaps/isrc';
import type { MisalignedAlbum } from '@/lib/gaps/misaligned';
import { cachedReleasesSharingBarcodes, type MissingRelease } from '@/lib/gaps/missing-releases';
import type { BarcodeGap } from '@/lib/gaps/barcodes';
import type { StreamingUrlGap } from '@/lib/gaps/streaming-urls';
import { withWorkCandidates, type WorkRelationshipGap } from '@/lib/gaps/work-relationships';
import {
  harmonyImportLink,
  magicIsrcLink,
  recordingEditLink,
  releaseEditLink,
  workCreateLink,
} from '@/lib/musicbrainz-edit-links';
import {
  blocksResubmission,
  describeLedgerState,
  describePreviousSubmission,
  needsExplicitResubmission,
  spotifyAlbumUrl,
  splitSubmissionHistory,
  submissionHistoryBy,
} from '@/lib/musicbrainz-manual-submissions';
import {
  AMBIGUOUS_BARCODE_REASON,
  normalisePickBarcode,
  type MbPickHit,
} from '@/lib/musicbrainz-pick';
import { readMissingReleases } from '@/lib/missing-release-store';
import { cachedPrecheckOf, type CachedPrecheck } from '@/lib/release-precheck-run';
import { preparedSeedOf, type PreparedSeed } from '@/lib/release-seeding-run';
import {
  ledgerIndex,
  readLedger,
  type LedgerHistory,
  type LedgerRow,
} from '@/lib/submission-ledger';
import type { InboxClass } from '../lib/admin-url';
import { tracksBlockedOnRelease } from '../lib/release-unblocks';
import { checkAuth } from './auth';

/** The submission in hand for a gap: its outcome, and the edit number or that it is missing. */
export type LedgerView = {
  id: number;
  outcome: string;
  editId: string | null;
  /** "pending · edit 123", or "rejected before (edit 123)" for history. */
  label: string;
};

/** An error report also says what the person did about the contradiction. */
export type ErrorLedgerView = LedgerView & { disposition: string | null };

/** The latest rejected or withdrawn attempt, kept so a returned gap shows its history. */
export type SubmissionHistoryView = {
  id: number;
  outcome: string;
  editId: string | null;
  /** Rejected: a batch leaves it out; only its own row resubmits it. */
  explicitOnly: boolean;
};

/** A gap row's ledger: the submission in hand, and the latest earlier attempt. */
type Ledgered<L extends LedgerView = LedgerView> = {
  ledger: L | null;
  previous: SubmissionHistoryView | null;
};

/** One work confirmation, in hand or before, with the work it named. */
export type WorkLedgerView = LedgerView & { workMbid: string | null };

export type WorkLedgerHistory = {
  current: WorkLedgerView | null;
  previous: WorkLedgerView | null;
};

export type ContributionView = {
  counts: ReturnType<typeof countContributions>;
  isrcReleases: {
    releaseMbid: string;
    albumId: string;
    albumTitle: string;
    missing: number;
    /** Tracks with no submission in hand, including ones rejected or withdrawn before. */
    eligible: number;
    /** What the bot, MagicISRC and hand-confirm send: eligible minus rejected before. */
    batch: number;
    /** Eligible tracks voters rejected before; each needs its own click. */
    rejected: number;
    link: string;
    /** The release's barcode, and ours — identical by construction, shown anyway. */
    barcode: string | null;
    upc: string | null;
    tracks: ({
      isrc: string;
      medium: number;
      position: number;
      trackTitle: string;
      recordingTitle: string;
      recordingMbid: string;
      upc: string | null;
      barcode: string | null;
      delta: number;
    } & Ledgered)[];
  }[];
  workGaps: (WorkRelationshipGap & {
    recordingEdit: string;
    workCreate: string;
    /** The new work confirmed for this recording, and the latest one rejected or withdrawn. */
    createdWork: WorkLedgerHistory;
    /** Per candidate work MBID: its relationship confirmation and the latest earlier one. */
    links: Record<string, WorkLedgerHistory>;
    /** Confirmations in hand (pending or applied), of either kind. */
    recorded: number;
    /** Whether any of those lacks its edit ID. */
    recordedWithoutEditId: boolean;
    /** Confirmations rejected or withdrawn before. */
    earlier: number;
  })[];
  contested: (ContestedIsrc & {
    isrcUrl: string;
    /** Which recording the library's own evidence says the ISRC belongs to. */
    judgement: ContestedIsrcJudgement | null;
  } & Ledgered<ErrorLedgerView>)[];
  missing: (MissingRelease & {
    /** Library tracks adding this release would unblock (the Overview's count); null if not counted. */
    libraryTracks: number | null;
    /** The cached pre-check; null until somebody runs it. */
    precheck: CachedPrecheck | null;
    /** Our prepared release-editor seed; null until somebody prepares it. */
    seed: PreparedSeed | null;
    harmony: string;
    barcodeHits: MbPickHit[];
  } & Ledgered<LedgerView & { releaseMbid: string | null }>)[];
  barcodes: (BarcodeGap & {
    edit: string;
  } & Ledgered<
      LedgerView & {
        /** The bot's note, which MusicBrainz did not attach to the edit. */
        unsentNote: string | null;
      }
    >)[];
  streamingUrls: (StreamingUrlGap & { edit: string; spotifyUrl: string } & Ledgered)[];
  misaligned: (MisalignedAlbum & Ledgered<ErrorLedgerView>)[];
  recent: {
    id: number;
    kind: string;
    targetMbid: string | null;
    value: string | null;
    submittedBy: string;
    submittedAt: Date;
    outcome: string;
    note: string | null;
  }[];
};

function ledgerView(row: LedgerRow): LedgerView {
  return {
    id: row.id,
    outcome: row.outcome,
    editId: row.editId,
    label: blocksResubmission(row.outcome)
      ? describeLedgerState(row)
      : describePreviousSubmission(row),
  };
}

function historyView(row: LedgerRow | null): SubmissionHistoryView | null {
  if (!row) return null;
  return {
    id: row.id,
    outcome: row.outcome,
    editId: row.editId,
    explicitOnly: needsExplicitResubmission(row),
  };
}

/** A gap's ledger fields, with any extra the section shows about the row in hand. */
function ledgered<Extra extends object>(
  history: LedgerHistory | undefined,
  extra: (row: LedgerRow) => Extra,
): Ledgered<LedgerView & Extra> {
  const current = history?.current ?? null;
  return {
    ledger: current ? { ...ledgerView(current), ...extra(current) } : null,
    previous: historyView(history?.previous ?? null),
  };
}

const plain = () => ({});

function errorDisposition(row: LedgerRow): { disposition: string | null } {
  return { disposition: row.evidence.kind === 'error' ? row.evidence.disposition : null };
}

function workView(row: LedgerRow | null): WorkLedgerView | null {
  return row ? { ...ledgerView(row), workMbid: row.value } : null;
}

/**
 * Both kinds of work confirmation for some recordings: a relationship is
 * keyed by its recording, a created work by the recording its evidence names.
 */
async function workLedgerByRecording(
  gaps: WorkRelationshipGap[],
): Promise<Map<string, LedgerRow[]>> {
  const recordingMbids = gaps.map((gap) => gap.recordingMbid);
  const albumIds = gaps.map((gap) => gap.albumId);
  const [relationships, creations] = await Promise.all([
    forChunks(recordingMbids, (chunk) =>
      readLedger(
        and(eq(mbSubmission.kind, 'work_relationship'), inArray(mbSubmission.targetMbid, chunk)),
      ),
    ),
    forChunks(albumIds, (chunk) =>
      readLedger(and(eq(mbSubmission.kind, 'work'), inArray(mbSubmission.subject, chunk))),
    ),
  ]);
  const byRecording = new Map<string, LedgerRow[]>();
  for (const row of [...relationships, ...creations]) {
    const recordingMbid =
      row.evidence.kind === 'work' ? row.evidence.recordingMbid : row.targetMbid;
    if (!recordingMbid) continue;
    byRecording.set(recordingMbid, [...(byRecording.get(recordingMbid) ?? []), row]);
  }
  return byRecording;
}

function workLedgerFields(rows: LedgerRow[]) {
  const inHand = rows.filter((row) => blocksResubmission(row.outcome));
  const created = splitSubmissionHistory(rows.filter((row) => row.kind === 'work'));
  const links = submissionHistoryBy(
    rows.filter((row) => row.kind === 'work_relationship'),
    (row) => row.value,
  );
  return {
    createdWork: { current: workView(created.current), previous: workView(created.previous) },
    links: Object.fromEntries(
      [...links].map(([workMbid, history]) => [
        workMbid,
        { current: workView(history.current), previous: workView(history.previous) },
      ]),
    ),
    recorded: inHand.length,
    recordedWithoutEditId: inHand.some((row) => !row.editId),
    earlier: rows.length - inHand.length,
  };
}

const isrcPairKey = (recordingMbid: string | null, isrc: string | null) =>
  recordingMbid && isrc ? `${recordingMbid}:${isrc}` : null;

function recentSubmissions() {
  return (
    db
      .select({
        id: mbSubmission.id,
        kind: mbSubmission.kind,
        targetMbid: mbSubmission.targetMbid,
        value: mbSubmission.value,
        submittedBy: mbSubmission.submittedBy,
        submittedAt: mbSubmission.submittedAt,
        outcome: mbSubmission.outcome,
        note: mbSubmission.note,
      })
      .from(mbSubmission)
      // Applied edits are done; the count says how many without listing them.
      .where(ne(mbSubmission.outcome, 'applied'))
      .orderBy(desc(mbSubmission.submittedAt))
      .limit(200)
  );
}

/**
 * The Inbox rows. With `only`, the other sections come back empty so a page
 * showing one section does not build all of them; the counts are always whole.
 *
 * Every gap list is read once, whole: the counts are its lengths and the
 * section's page is its first rows. Then everything the page's rows need —
 * ledger, judgements, pre-checks, seeds — is read at once.
 */
export async function getContributions(
  limits?: Partial<ContributionListLimits>,
  only?: InboxClass,
): Promise<ContributionView> {
  await checkAuth();
  const page = resolveContributionLimits(limits);
  const shows = (section: InboxClass) => only === undefined || only === section;
  const take = <T>(section: InboxClass, rows: T[], limit: number): T[] =>
    shows(section) ? pageSlice(rows, limit) : [];

  const [lists, submissions, unblocks, recent] = await Promise.all([
    gapLists(),
    submissionCounts(),
    shows('missing') ? tracksBlockedOnRelease() : null,
    shows('submitted') ? recentSubmissions() : [],
  ]);

  const releases = take('isrc', isrcGapReleases(lists.isrc), page.isrcReleases);
  const contested = take('contested', lists.contested, page.contested);
  const missing = take('missing', rankMissingReleases(lists.missing, unblocks), page.missing);
  const barcodes = take('barcodes', lists.barcodes, page.barcodes);
  const streamingUrls = take('streaming', lists.streaming, page.streamingUrls);
  const misaligned = take('misaligned', lists.misaligned, page.misaligned);
  const workGaps = await withWorkCandidates(take('work', lists.work, page.workGaps));

  const missingAlbumIds = missing.map((album) => album.albumId);
  const [
    isrcLedger,
    workLedger,
    contestedJudgements,
    contestedLedger,
    releaseLedger,
    barcodeHitsByUpc,
    missingStages,
    barcodeLedger,
    streamingLedger,
    misalignedLedger,
  ] = await Promise.all([
    ledgerIndex(
      'isrc',
      'targetMbid',
      releases.flatMap((release) => release.gaps.map((gap) => gap.recordingMbid)),
      (row) => isrcPairKey(row.targetMbid, row.value),
    ),
    workLedgerByRecording(workGaps),
    judgeContestedIsrcs(contested),
    ledgerIndex(
      'error',
      'value',
      contested.map((row) => row.isrc),
    ),
    ledgerIndex('release', 'subject', missingAlbumIds),
    cachedReleasesSharingBarcodes(
      missing
        .filter((album) => album.reason === AMBIGUOUS_BARCODE_REASON)
        .map((album) => album.upc)
        .filter((upc): upc is string => Boolean(upc)),
    ),
    readMissingReleases(missingAlbumIds),
    ledgerIndex(
      'barcode',
      'targetMbid',
      barcodes.map((gap) => gap.releaseMbid),
    ),
    ledgerIndex(
      'streaming_url',
      'subject',
      streamingUrls.map((gap) => gap.albumId),
    ),
    ledgerIndex(
      'error',
      'subject',
      misaligned.map((album) => album.albumId),
    ),
  ]);

  return {
    counts: countContributions(lists, submissions),
    isrcReleases: releases.map((release) => {
      const tracks = release.gaps.map((gap) => ({
        isrc: gap.isrc,
        medium: gap.medium,
        position: gap.position,
        trackTitle: gap.trackTitle,
        recordingTitle: gap.recordingTitle,
        recordingMbid: gap.recordingMbid,
        upc: gap.upc,
        barcode: gap.barcode,
        delta: gap.durationDeltaMs,
        ...ledgered(isrcLedger.get(`${gap.recordingMbid}:${gap.isrc}`), plain),
      }));
      const eligible = tracks.filter((track) => !track.ledger);
      // Rejected before: offered again, but only through the track's own click.
      const batch = release.gaps.filter(
        (gap, index) => !tracks[index].ledger && !tracks[index].previous?.explicitOnly,
      );
      return {
        releaseMbid: release.releaseMbid,
        albumId: release.albumId,
        albumTitle: release.albumTitle,
        missing: release.missing,
        eligible: eligible.length,
        batch: batch.length,
        rejected: eligible.length - batch.length,
        link: batch.length === 0 ? '' : magicIsrcLink(release.releaseMbid, batch),
        barcode: release.gaps[0]?.barcode ?? null,
        upc: release.gaps[0]?.upc ?? null,
        tracks,
      };
    }),
    workGaps: workGaps.map((gap) => ({
      ...gap,
      recordingEdit: recordingEditLink(gap.recordingMbid),
      workCreate: workCreateLink(),
      ...workLedgerFields(workLedger.get(gap.recordingMbid) ?? []),
    })),
    contested: contested.map((row) => ({
      ...row,
      isrcUrl: `https://musicbrainz.org/isrc/${row.isrc}`,
      judgement: contestedJudgements.get(row.isrc) ?? null,
      ...ledgered(contestedLedger.get(row.isrc), errorDisposition),
    })),
    missing: missing.map((album) => ({
      ...album,
      precheck: cachedPrecheckOf(missingStages.get(album.albumId) ?? {}),
      seed: preparedSeedOf(missingStages.get(album.albumId) ?? {}),
      harmony: harmonyImportLink(album.albumId),
      barcodeHits:
        album.reason === AMBIGUOUS_BARCODE_REASON
          ? (barcodeHitsByUpc.get(normalisePickBarcode(album.upc) ?? '') ?? [])
          : [],
      ...ledgered(releaseLedger.get(album.albumId), (row) => ({
        releaseMbid: row.evidence.kind === 'release' ? row.evidence.releaseMbid : null,
      })),
    })),
    barcodes: barcodes.map((gap) => ({
      ...gap,
      edit: releaseEditLink(gap.releaseMbid),
      ...ledgered(barcodeLedger.get(gap.releaseMbid), (row) => ({
        // MusicBrainz drops the note on bot barcode edits (MBS-14476).
        unsentNote: row.submittedBy.startsWith('bot:') && row.note ? row.note : null,
      })),
    })),
    streamingUrls: streamingUrls.map((gap) => ({
      ...gap,
      edit: releaseEditLink(gap.releaseMbid),
      spotifyUrl: spotifyAlbumUrl(gap.albumId),
      ...ledgered(streamingLedger.get(gap.albumId), plain),
    })),
    misaligned: misaligned.map((album) => ({
      ...album,
      ...ledgered(misalignedLedger.get(album.albumId), errorDisposition),
    })),
    recent,
  };
}
