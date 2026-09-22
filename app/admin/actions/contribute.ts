'use server';

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mbSubmission, mbWork } from '@/lib/db/schema';
import { resolveContributionLimits, type ContributionListLimits } from '@/lib/contribution-list';
import {
  attachPickedRelease,
  barcodeGaps,
  contestedIsrcs,
  contributionCounts,
  cachedReleasesSharingBarcodes,
  harmonyImportLink,
  isrcEligibleGapsByRelease,
  isrcGapsByRelease,
  magicIsrcLink,
  misalignedAlbums,
  missingReleases,
  observeAlbumReleaseMatch,
  observeCachedBarcode,
  observeRecordingWorkLinks,
  observeSpotifyFreeStreamingUrlState,
  releaseEditLink,
  recordingEditLink,
  streamingUrlGaps,
  workCreateLink,
  workRelationshipGaps,
  type IsrcGap,
} from '@/lib/musicbrainz-contributions';
import {
  editsSpentToday,
  MusicBrainzBotError,
  runBarcodeBot,
  runIsrcBot,
} from '@/lib/musicbrainz-bot';
import { botCredentials } from '@/lib/musicbrainz-oauth';
import { musicBrainzApi } from '@/lib/musicbrainz';
import { ingestWorkTree } from '@/lib/musicbrainz-cache';
import {
  AMBIGUOUS_BARCODE_REASON,
  mbApiReleaseToPickHit,
  normalisePickBarcode,
  type MbPickHit,
  type PickedReleaseAttachRequest,
} from '@/lib/musicbrainz-pick';
import {
  barcodeSubmissionDraft,
  cachedBarcodeLanded,
  cachedReleaseMatchLanded,
  cachedStreamingUrlLanded,
  cachedWorkRelationshipLanded,
  createdWorkCacheState,
  createdWorkLanded,
  describeLedgerState,
  errorReportDraftFromContested,
  errorReportDraftFromMisaligned,
  ManualSubmissionError,
  normalizeEditId,
  requireMbid,
  workCreationDraftFromGap,
  workRelationshipDraftFromGap,
  releaseSubmissionDraftFromGap,
  spotifyAlbumUrl,
  streamingUrlDraftFromGap,
  type ManualSubmissionDraft,
} from '@/lib/musicbrainz-manual-submissions';
import { checkAuth } from './auth';

/**
 * What the bot would submit, without submitting it.
 *
 * Separate from the submit action on purpose. Every batch is looked at
 * before it is sent: the evidence is shown, the edit note is shown, and the
 * payload is available to read. Automation is something each class of edit
 * earns, and for now the earning is somebody deciding one batch at a time.
 */
export type BotStatus = {
  configured: boolean;
  spentToday: number;
  dailyCap: number;
  error: string | null;
};

/** Whether the bot can submit, and how much of today's allowance is left. */
export async function getBotStatus(): Promise<BotStatus> {
  await checkAuth();
  return {
    configured: botCredentials() !== null,
    spentToday: await editsSpentToday().catch(() => 0),
    dailyCap: 1000,
    error: null,
  };
}

/**
 * The exact document that would be sent for one release.
 *
 * Kept available because "show me what you would actually post" is the last
 * check before trusting a machine with somebody else's database, and a
 * summary is not that.
 */
export async function getBotPayload(releaseMbid: string): Promise<string> {
  await checkAuth();
  const run = await runIsrcBot({ apply: false, releaseMbid });
  return run.payload;
}

export async function submitBotBatch(releaseMbid: string): Promise<{
  submitted: number;
  album: string | null;
  error: string | null;
  view: ContributionView;
}> {
  await checkAuth();
  try {
    const run = await runIsrcBot({ apply: true, releaseMbid });
    return {
      submitted: run.edits,
      album: run.albumTitle,
      error: null,
      view: await getContributions(),
    };
  } catch (error) {
    const message =
      error instanceof MusicBrainzBotError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { submitted: 0, album: null, error: message, view: await getContributions() };
  }
}

/** The exact barcode document that would be sent for one release. */
export async function getBarcodeBotPayload(releaseMbid: string): Promise<string> {
  await checkAuth();
  const run = await runBarcodeBot({ apply: false, releaseMbid });
  return run.payload;
}

export async function submitBarcodeBotBatch(releaseMbid: string): Promise<{
  submitted: number;
  release: string | null;
  error: string | null;
  view: ContributionView;
}> {
  await checkAuth();
  try {
    const run = await runBarcodeBot({ apply: true, releaseMbid });
    return {
      submitted: run.edits,
      release: run.evidence[0]?.releaseTitle ?? null,
      error: null,
      view: await getContributions(),
    };
  } catch (error) {
    const message =
      error instanceof MusicBrainzBotError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { submitted: 0, release: null, error: message, view: await getContributions() };
  }
}

export type ContributionView = {
  counts: Awaited<ReturnType<typeof contributionCounts>>;
  isrcReleases: {
    releaseMbid: string;
    albumId: string;
    albumTitle: string;
    missing: number;
    eligible: number;
    link: string;
    /** The release's barcode, and ours — identical by construction, shown anyway. */
    barcode: string | null;
    upc: string | null;
    tracks: {
      isrc: string;
      medium: number;
      position: number;
      trackTitle: string;
      recordingTitle: string;
      recordingMbid: string;
      upc: string | null;
      barcode: string | null;
      delta: number;
      ledger: {
        id: number;
        outcome: string;
        editId: string | null;
        label: string;
      } | null;
    }[];
  }[];
  workGaps: (Awaited<ReturnType<typeof workRelationshipGaps>>[number] & {
    recordingEdit: string;
    workCreate: string;
    ledger: {
      id: number;
      kind: string;
      workMbid: string | null;
      outcome: string;
      editId: string | null;
      submittedAt: Date;
      submittedBy: string;
      label: string;
    }[];
  })[];
  contested: (Awaited<ReturnType<typeof contestedIsrcs>>[number] & {
    isrcUrl: string;
    ledger: {
      id: number;
      outcome: string;
      editId: string | null;
      disposition: string | null;
      label: string;
    } | null;
  })[];
  missing: (Awaited<ReturnType<typeof missingReleases>>[number] & {
    harmony: string;
    barcodeHits: MbPickHit[];
    ledger: {
      id: number;
      outcome: string;
      editId: string | null;
      releaseMbid: string | null;
      label: string;
    } | null;
  })[];
  barcodes: (Awaited<ReturnType<typeof barcodeGaps>>[number] & {
    edit: string;
    ledger: {
      id: number;
      outcome: string;
      editId: string | null;
      label: string;
    } | null;
  })[];
  streamingUrls: (Awaited<ReturnType<typeof streamingUrlGaps>>[number] & {
    edit: string;
    spotifyUrl: string;
    ledger: {
      id: number;
      outcome: string;
      editId: string | null;
      label: string;
    } | null;
  })[];
  misaligned: (Awaited<ReturnType<typeof misalignedAlbums>>[number] & {
    ledger: {
      id: number;
      outcome: string;
      editId: string | null;
      disposition: string | null;
      label: string;
    } | null;
  })[];
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

export async function getContributions(
  limits?: Partial<ContributionListLimits>,
): Promise<ContributionView> {
  await checkAuth();
  const page = resolveContributionLimits(limits);

  const [
    counts,
    releases,
    workGaps,
    contested,
    missing,
    barcodes,
    streamingUrls,
    misaligned,
    recent,
  ] = await Promise.all([
    contributionCounts(),
    isrcGapsByRelease(page.isrcReleases),
    workRelationshipGaps(page.workGaps),
    contestedIsrcs(page.contested),
    missingReleases(page.missing),
    barcodeGaps(page.barcodes),
    streamingUrlGaps(page.streamingUrls),
    misalignedAlbums(page.misaligned),
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
      .orderBy(desc(mbSubmission.submittedAt))
      .limit(30),
  ]);

  const recordingMbids = workGaps.map((gap) => gap.recordingMbid);
  const albumIds = [...new Set(workGaps.map((gap) => gap.albumId))];
  const [relationshipRows, creationRows] =
    recordingMbids.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              id: mbSubmission.id,
              kind: mbSubmission.kind,
              recordingMbid: mbSubmission.targetMbid,
              workMbid: mbSubmission.value,
              outcome: mbSubmission.outcome,
              editId: mbSubmission.editId,
              submittedAt: mbSubmission.submittedAt,
              submittedBy: mbSubmission.submittedBy,
            })
            .from(mbSubmission)
            .where(
              and(
                eq(mbSubmission.kind, 'work_relationship'),
                inArray(mbSubmission.targetMbid, recordingMbids),
              ),
            ),
          albumIds.length === 0
            ? Promise.resolve([])
            : db
                .select({
                  id: mbSubmission.id,
                  kind: mbSubmission.kind,
                  workMbid: mbSubmission.value,
                  outcome: mbSubmission.outcome,
                  editId: mbSubmission.editId,
                  submittedAt: mbSubmission.submittedAt,
                  submittedBy: mbSubmission.submittedBy,
                  evidence: mbSubmission.evidence,
                })
                .from(mbSubmission)
                .where(and(eq(mbSubmission.kind, 'work'), inArray(mbSubmission.subject, albumIds))),
        ]);
  const ledgerByRecording = new Map<
    string,
    {
      id: number;
      kind: string;
      workMbid: string | null;
      outcome: string;
      editId: string | null;
      submittedAt: Date;
      submittedBy: string;
    }[]
  >();
  const pushLedger = (
    recordingMbid: string | null,
    row: {
      id: number;
      kind: string;
      workMbid: string | null;
      outcome: string;
      editId: string | null;
      submittedAt: Date;
      submittedBy: string;
    },
  ) => {
    if (!recordingMbid) return;
    const list = ledgerByRecording.get(recordingMbid) ?? [];
    list.push(row);
    ledgerByRecording.set(recordingMbid, list);
  };
  for (const row of relationshipRows) {
    pushLedger(row.recordingMbid, row);
  }
  for (const row of creationRows) {
    const recordingMbid = (row.evidence as { recordingMbid?: unknown } | null)?.recordingMbid;
    pushLedger(typeof recordingMbid === 'string' ? recordingMbid : null, row);
  }

  const missingAlbumIds = missing.map((album) => album.albumId);
  const [releaseLedgerRows, barcodeHitsByUpc] = await Promise.all([
    missingAlbumIds.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: mbSubmission.id,
            albumId: mbSubmission.subject,
            outcome: mbSubmission.outcome,
            editId: mbSubmission.editId,
            evidence: mbSubmission.evidence,
          })
          .from(mbSubmission)
          .where(
            and(eq(mbSubmission.kind, 'release'), inArray(mbSubmission.subject, missingAlbumIds)),
          ),
    cachedReleasesSharingBarcodes(
      missing
        .filter((album) => album.reason === AMBIGUOUS_BARCODE_REASON)
        .map((album) => album.upc)
        .filter((upc): upc is string => Boolean(upc)),
    ),
  ]);
  const releaseLedgerByAlbum = new Map(
    releaseLedgerRows.map((row) => {
      const releaseMbid = (row.evidence as { releaseMbid?: unknown } | null)?.releaseMbid;
      return [
        row.albumId,
        {
          id: row.id,
          outcome: row.outcome,
          editId: row.editId,
          releaseMbid: typeof releaseMbid === 'string' ? releaseMbid : null,
          label: describeLedgerState(row),
        },
      ] as const;
    }),
  );

  const contestedIsrcValues = contested.map((row) => row.isrc);
  const misalignedAlbumIds = misaligned.map((album) => album.albumId);
  const errorLedgerRows =
    contestedIsrcValues.length === 0 && misalignedAlbumIds.length === 0
      ? []
      : await db
          .select({
            id: mbSubmission.id,
            targetMbid: mbSubmission.targetMbid,
            subject: mbSubmission.subject,
            value: mbSubmission.value,
            outcome: mbSubmission.outcome,
            editId: mbSubmission.editId,
            evidence: mbSubmission.evidence,
          })
          .from(mbSubmission)
          .where(
            and(
              eq(mbSubmission.kind, 'error'),
              or(
                contestedIsrcValues.length > 0
                  ? inArray(mbSubmission.value, contestedIsrcValues)
                  : undefined,
                misalignedAlbumIds.length > 0
                  ? inArray(mbSubmission.subject, misalignedAlbumIds)
                  : undefined,
              ),
            ),
          );

  function errorLedgerOf(match: (row: (typeof errorLedgerRows)[number]) => boolean): {
    id: number;
    outcome: string;
    editId: string | null;
    disposition: string | null;
    label: string;
  } | null {
    const row = errorLedgerRows.find(match);
    if (!row) return null;
    const disposition = (row.evidence as { disposition?: unknown } | null)?.disposition;
    return {
      id: row.id,
      outcome: row.outcome,
      editId: row.editId,
      disposition: typeof disposition === 'string' ? disposition : null,
      label: describeLedgerState(row),
    };
  }

  const streamingAlbumIds = streamingUrls.map((gap) => gap.albumId);
  const streamingLedgerRows =
    streamingAlbumIds.length === 0
      ? []
      : await db
          .select({
            id: mbSubmission.id,
            albumId: mbSubmission.subject,
            outcome: mbSubmission.outcome,
            editId: mbSubmission.editId,
          })
          .from(mbSubmission)
          .where(
            and(
              eq(mbSubmission.kind, 'streaming_url'),
              inArray(mbSubmission.subject, streamingAlbumIds),
            ),
          );
  const streamingLedgerByAlbum = new Map(
    streamingLedgerRows.map((row) => [
      row.albumId,
      {
        id: row.id,
        outcome: row.outcome,
        editId: row.editId,
        label: describeLedgerState(row),
      },
    ]),
  );

  const barcodeReleaseMbids = barcodes.map((gap) => gap.releaseMbid);
  const barcodeLedgerRows =
    barcodeReleaseMbids.length === 0
      ? []
      : await db
          .select({
            id: mbSubmission.id,
            releaseMbid: mbSubmission.targetMbid,
            outcome: mbSubmission.outcome,
            editId: mbSubmission.editId,
          })
          .from(mbSubmission)
          .where(
            and(
              eq(mbSubmission.kind, 'barcode'),
              inArray(mbSubmission.targetMbid, barcodeReleaseMbids),
            ),
          );
  const barcodeLedgerByRelease = new Map(
    barcodeLedgerRows.map((row) => [
      row.releaseMbid,
      {
        id: row.id,
        outcome: row.outcome,
        editId: row.editId,
        label: describeLedgerState(row),
      },
    ]),
  );

  const isrcRecordingMbids = [
    ...new Set(releases.flatMap((release) => release.gaps.map((gap) => gap.recordingMbid))),
  ];
  const isrcLedgerRows =
    isrcRecordingMbids.length === 0
      ? []
      : await db
          .select({
            id: mbSubmission.id,
            recordingMbid: mbSubmission.targetMbid,
            isrc: mbSubmission.value,
            outcome: mbSubmission.outcome,
            editId: mbSubmission.editId,
          })
          .from(mbSubmission)
          .where(
            and(
              eq(mbSubmission.kind, 'isrc'),
              inArray(mbSubmission.targetMbid, isrcRecordingMbids),
            ),
          );
  const isrcLedgerByPair = new Map(
    isrcLedgerRows.flatMap((row) => {
      if (!row.recordingMbid || !row.isrc) return [];
      return [
        [
          `${row.recordingMbid}:${row.isrc}`,
          {
            id: row.id,
            outcome: row.outcome,
            editId: row.editId,
            label: describeLedgerState(row),
          },
        ] as const,
      ];
    }),
  );

  return {
    counts,
    isrcReleases: releases.map((release) => {
      const tracks = release.gaps.map((gap: IsrcGap) => ({
        isrc: gap.isrc,
        medium: gap.medium,
        position: gap.position,
        trackTitle: gap.trackTitle,
        recordingTitle: gap.recordingTitle,
        recordingMbid: gap.recordingMbid,
        upc: gap.upc,
        barcode: gap.barcode,
        delta: gap.durationDeltaMs,
        ledger: isrcLedgerByPair.get(`${gap.recordingMbid}:${gap.isrc}`) ?? null,
      }));
      const eligible = release.gaps.filter(
        (gap) => !isrcLedgerByPair.has(`${gap.recordingMbid}:${gap.isrc}`),
      );
      return {
        releaseMbid: release.releaseMbid,
        albumId: release.albumId,
        albumTitle: release.albumTitle,
        missing: release.missing,
        eligible: eligible.length,
        link: eligible.length === 0 ? '' : magicIsrcLink(release.releaseMbid, eligible),
        barcode: release.gaps[0]?.barcode ?? null,
        upc: release.gaps[0]?.upc ?? null,
        tracks,
      };
    }),
    workGaps: workGaps.map((gap) => ({
      ...gap,
      recordingEdit: recordingEditLink(gap.recordingMbid),
      workCreate: workCreateLink(),
      ledger: (ledgerByRecording.get(gap.recordingMbid) ?? []).map((row) => ({
        id: row.id,
        kind: row.kind,
        workMbid: row.workMbid,
        outcome: row.outcome,
        editId: row.editId,
        submittedAt: row.submittedAt,
        submittedBy: row.submittedBy,
        label: describeLedgerState(row),
      })),
    })),
    contested: contested.map((row) => ({
      ...row,
      isrcUrl: `https://musicbrainz.org/isrc/${row.isrc}`,
      ledger: errorLedgerOf((entry) => entry.value === row.isrc),
    })),
    missing: missing.map((album) => ({
      ...album,
      harmony: harmonyImportLink(album.albumId),
      barcodeHits:
        album.reason === AMBIGUOUS_BARCODE_REASON
          ? (barcodeHitsByUpc.get(normalisePickBarcode(album.upc) ?? '') ?? [])
          : [],
      ledger: releaseLedgerByAlbum.get(album.albumId) ?? null,
    })),
    barcodes: barcodes.map((gap) => ({
      ...gap,
      edit: releaseEditLink(gap.releaseMbid),
      ledger: barcodeLedgerByRelease.get(gap.releaseMbid) ?? null,
    })),
    streamingUrls: streamingUrls.map((gap) => ({
      ...gap,
      edit: releaseEditLink(gap.releaseMbid),
      spotifyUrl: spotifyAlbumUrl(gap.albumId),
      ledger: streamingLedgerByAlbum.get(gap.albumId) ?? null,
    })),
    misaligned: misaligned.map((album) => ({
      ...album,
      ledger: errorLedgerOf((entry) => entry.subject === album.albumId),
    })),
    recent,
  };
}

/**
 * Record that a release's ISRCs were submitted.
 *
 * Written when the person says they submitted, not when the link is opened,
 * because opening a link is not an edit. The outcome stays `pending`: a
 * MusicBrainz edit is a proposal that editors vote on, and marking it applied
 * here would be recording our intention rather than the result.
 */
export async function recordIsrcSubmission(
  releaseMbid: string,
  options: { note?: string; editId?: string } = {},
) {
  const session = await checkAuth();
  const submitter = `human:${session.user.name}`;
  const editId = normalizeEditId(options.editId);

  const releases = await isrcEligibleGapsByRelease(500);
  const release = releases.find((candidate) => candidate.releaseMbid === releaseMbid);
  if (!release) throw new Error('That release has no outstanding ISRCs');

  for (const gap of release.gaps) {
    await db
      .insert(mbSubmission)
      .values({
        kind: 'isrc',
        targetMbid: gap.recordingMbid,
        subject: gap.spotifyTrackId,
        value: gap.isrc,
        evidence: {
          releaseMbid: gap.releaseMbid,
          barcode: gap.barcode,
          medium: gap.medium,
          position: gap.position,
          durationDeltaMs: gap.durationDeltaMs,
          matchedBy: gap.matchedBy,
        },
        submittedBy: submitter,
        note: options.note?.trim() || null,
        editId,
      })
      .onConflictDoNothing();
  }

  return getContributions();
}

/**
 * Observe whether the cache now holds ISRCs confirmed for this release.
 *
 * Reads only. Each pending row is applied only when `mb_recording_isrc`
 * shows that pair. A still-missing ISRC stays pending, and a missing edit
 * ID stays missing.
 */
export async function recheckIsrcRelease(releaseMbid: string) {
  await checkAuth();
  const release = requireMbid(releaseMbid, 'The release');
  const pending = await db
    .select({ id: mbSubmission.id })
    .from(mbSubmission)
    .where(
      and(
        eq(mbSubmission.kind, 'isrc'),
        eq(mbSubmission.outcome, 'pending'),
        sql`json_extract(${mbSubmission.evidence}, '$.releaseMbid') = ${release}`,
      ),
    )
    .limit(1);
  if (!pending[0]) {
    throw new ManualSubmissionError('That release has no ISRC confirmation');
  }

  const applied = await db
    .update(mbSubmission)
    .set({ outcome: 'applied', outcomeAt: new Date() })
    .where(
      and(
        eq(mbSubmission.kind, 'isrc'),
        eq(mbSubmission.outcome, 'pending'),
        sql`json_extract(${mbSubmission.evidence}, '$.releaseMbid') = ${release}`,
        sql`exists (
          select 1 from mb_recording_isrc
          where mb_recording_isrc.recording_mbid = ${mbSubmission.targetMbid}
            and mb_recording_isrc.isrc = ${mbSubmission.value}
        )`,
      ),
    )
    .returning({ id: mbSubmission.id });

  return { applied: applied.length, view: await getContributions() };
}

async function recordManualSubmission(
  submittedBy: string,
  draft: ManualSubmissionDraft,
  options: { note?: string; editId?: string } = {},
) {
  await db
    .insert(mbSubmission)
    .values({
      ...draft,
      submittedBy,
      note: options.note?.trim() || null,
      editId: normalizeEditId(options.editId),
    })
    .onConflictDoNothing();
}

/** Record a barcode only after the editor confirms making the external edit. */
export async function recordBarcodeSubmission(
  releaseMbid: string,
  options: { note?: string; editId?: string } = {},
) {
  const session = await checkAuth();
  const gap = (await barcodeGaps(5_000)).find((candidate) => candidate.releaseMbid === releaseMbid);
  if (!gap) {
    throw new ManualSubmissionError('That release has no outstanding barcode contribution');
  }

  await recordManualSubmission(`human:${session.user.name}`, barcodeSubmissionDraft(gap), options);
  return getContributions();
}

/**
 * Observe whether the cache now holds a barcode for a confirmed submission.
 *
 * Reads only. Applied only when MusicBrainz's cached release has a barcode;
 * a still-empty field stays pending. A missing edit ID stays missing.
 */
export async function recheckBarcode(releaseMbid: string) {
  await checkAuth();
  const release = requireMbid(releaseMbid, 'The release');
  const [confirmed] = await db
    .select({ id: mbSubmission.id })
    .from(mbSubmission)
    .where(and(eq(mbSubmission.kind, 'barcode'), eq(mbSubmission.targetMbid, release)))
    .limit(1);
  if (!confirmed) {
    throw new ManualSubmissionError('That release has no barcode confirmation');
  }

  const barcode = await observeCachedBarcode(release);
  const landed = cachedBarcodeLanded(barcode);
  if (landed) {
    await db
      .update(mbSubmission)
      .set({ outcome: 'applied', outcomeAt: new Date() })
      .where(
        and(
          eq(mbSubmission.kind, 'barcode'),
          eq(mbSubmission.targetMbid, release),
          eq(mbSubmission.outcome, 'pending'),
        ),
      );
  }

  return { landed, view: await getContributions() };
}

/** Record a recording–work link only after the editor confirms the external edit. */
export async function recordWorkRelationshipSubmission(
  recordingMbid: string,
  workMbid: string,
  options: { note?: string; editId?: string } = {},
) {
  const session = await checkAuth();
  const recording = requireMbid(recordingMbid, 'The recording');
  const gap = (await workRelationshipGaps(5_000)).find(
    (candidate) => candidate.recordingMbid === recording,
  );
  if (!gap) {
    throw new ManualSubmissionError('That recording has no outstanding work relationship');
  }

  await recordManualSubmission(
    `human:${session.user.name}`,
    workRelationshipDraftFromGap(gap, workMbid),
    options,
  );
  return getContributions();
}

/**
 * Observe whether the cache now holds the recording–work link we confirmed.
 *
 * Reads only. Applied only when that pair is in `mb_recording_work`.
 */
export async function recheckWorkRelationship(recordingMbid: string, workMbid: string) {
  await checkAuth();
  const recording = requireMbid(recordingMbid, 'The recording');
  const work = requireMbid(workMbid, 'The work');
  const [confirmed] = await db
    .select({ id: mbSubmission.id })
    .from(mbSubmission)
    .where(
      and(
        eq(mbSubmission.kind, 'work_relationship'),
        eq(mbSubmission.targetMbid, recording),
        eq(mbSubmission.value, work),
      ),
    )
    .limit(1);
  if (!confirmed) {
    throw new ManualSubmissionError('That recording has no work-relationship confirmation');
  }

  const linked = await observeRecordingWorkLinks(recording);
  const landed = cachedWorkRelationshipLanded(linked, work);
  if (landed) {
    await db
      .update(mbSubmission)
      .set({ outcome: 'applied', outcomeAt: new Date() })
      .where(
        and(
          eq(mbSubmission.kind, 'work_relationship'),
          eq(mbSubmission.targetMbid, recording),
          eq(mbSubmission.value, work),
          eq(mbSubmission.outcome, 'pending'),
        ),
      );
  }

  return { landed, view: await getContributions() };
}

/** Record a newly created work only after the editor pastes its MBID. */
export async function recordWorkCreationSubmission(
  recordingMbid: string,
  workMbid: string,
  options: { note?: string; editId?: string; localWorkId?: number } = {},
) {
  const session = await checkAuth();
  const recording = requireMbid(recordingMbid, 'The recording');
  const gap = (await workRelationshipGaps(5_000)).find(
    (candidate) => candidate.recordingMbid === recording,
  );
  if (!gap) {
    throw new ManualSubmissionError('That recording has no outstanding work relationship');
  }

  await recordManualSubmission(
    `human:${session.user.name}`,
    workCreationDraftFromGap(gap, workMbid, options.localWorkId),
    options,
  );
  return getContributions();
}

/**
 * Live MusicBrainz hits for a barcode, used when the cache does not yet hold
 * the releases that share it.
 *
 * Reads only. Does not ingest, does not write the album's matched release,
 * and does not write the ledger.
 */
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

/** Attach a cached release pick to the Spotify album. Does not ledger or ingest. */
export async function attachPickedReleaseToAlbum(request: PickedReleaseAttachRequest) {
  await checkAuth();
  return attachPickedRelease(request);
}

/** Record a Harmony submission only after the editor confirms the external edit. */
export async function recordReleaseSubmission(
  albumId: string,
  options: { note?: string; editId?: string; releaseMbid?: string } = {},
) {
  const session = await checkAuth();
  const gap = (await missingReleases(5_000)).find((album) => album.albumId === albumId);
  if (!gap) {
    throw new ManualSubmissionError('That album is not a missing-release contribution');
  }

  await recordManualSubmission(
    `human:${session.user.name}`,
    releaseSubmissionDraftFromGap(gap, options.releaseMbid),
    options,
  );
  return getContributions();
}

/**
 * Observe whether the album we submitted via Harmony is now matched.
 *
 * Reads only. Applied only when the cache holds a release MBID for it. A
 * Harmony edit still in the queue, with no MBID yet, stays pending.
 */
export async function recheckReleaseSubmission(albumId: string) {
  await checkAuth();
  const [confirmed] = await db
    .select({ id: mbSubmission.id })
    .from(mbSubmission)
    .where(and(eq(mbSubmission.kind, 'release'), eq(mbSubmission.subject, albumId)))
    .limit(1);
  if (!confirmed) {
    throw new ManualSubmissionError('That album has no release confirmation');
  }

  const mbReleaseId = await observeAlbumReleaseMatch(albumId);
  const landed = cachedReleaseMatchLanded(mbReleaseId);
  if (landed) {
    await db
      .update(mbSubmission)
      .set({ outcome: 'applied', outcomeAt: new Date() })
      .where(
        and(
          eq(mbSubmission.kind, 'release'),
          eq(mbSubmission.subject, albumId),
          eq(mbSubmission.outcome, 'pending'),
        ),
      );
  }

  return { landed, view: await getContributions() };
}

/**
 * Record a Spotify free-streaming URL only after the editor confirms the
 * external edit. Opening the release edit page does not write.
 */
export async function recordStreamingUrlSubmission(
  releaseMbid: string,
  albumId: string,
  options: { note?: string; editId?: string } = {},
) {
  const session = await checkAuth();
  const release = requireMbid(releaseMbid, 'The release');
  const gap = (await streamingUrlGaps(5_000)).find(
    (candidate) => candidate.releaseMbid === release && candidate.albumId === albumId,
  );
  if (!gap) {
    throw new ManualSubmissionError(
      'That release is not a known-fetched streaming-URL contribution',
    );
  }

  await recordManualSubmission(
    `human:${session.user.name}`,
    streamingUrlDraftFromGap(gap),
    options,
  );
  return getContributions();
}

/**
 * Observe whether the cache now holds an active Spotify free-streaming URL.
 *
 * Reads only. Applied only when that relation is present. Missing stays
 * pending. Unknown — URL relations not fetched — also stays pending: absence
 * of a fetch is not evidence the edit landed.
 */
export async function recheckStreamingUrl(releaseMbid: string) {
  await checkAuth();
  const release = requireMbid(releaseMbid, 'The release');
  const [confirmed] = await db
    .select({ id: mbSubmission.id })
    .from(mbSubmission)
    .where(and(eq(mbSubmission.kind, 'streaming_url'), eq(mbSubmission.targetMbid, release)))
    .limit(1);
  if (!confirmed) {
    throw new ManualSubmissionError('That release has no streaming-URL confirmation');
  }

  const state = await observeSpotifyFreeStreamingUrlState(release);
  if (cachedStreamingUrlLanded(state)) {
    await db
      .update(mbSubmission)
      .set({ outcome: 'applied', outcomeAt: new Date() })
      .where(
        and(
          eq(mbSubmission.kind, 'streaming_url'),
          eq(mbSubmission.targetMbid, release),
          eq(mbSubmission.outcome, 'pending'),
        ),
      );
  }

  return { state, view: await getContributions() };
}

/**
 * Record that a person reported or fixed a contested ISRC. Does not change
 * cached MusicBrainz facts: the contradiction stays visible until upstream
 * does and a later recheck observes that.
 */
export async function recordContestedIsrcReport(
  isrc: string,
  disposition: string,
  options: { note?: string; editId?: string } = {},
) {
  const session = await checkAuth();
  const gap = (await contestedIsrcs(5_000)).find((row) => row.isrc === isrc);
  if (!gap) {
    throw new ManualSubmissionError('That ISRC is not currently contested in the cache');
  }

  await recordManualSubmission(
    `human:${session.user.name}`,
    errorReportDraftFromContested(gap, disposition),
    options,
  );
  return getContributions();
}

/**
 * Record that a person reported or fixed a misaligned tracklist. The cache
 * is left as MusicBrainz stated it.
 */
export async function recordMisalignedTracklistReport(
  albumId: string,
  disposition: string,
  options: { note?: string; editId?: string } = {},
) {
  const session = await checkAuth();
  const gap = (await misalignedAlbums(5_000)).find((album) => album.albumId === albumId);
  if (!gap) {
    throw new ManualSubmissionError('That album is not currently a misaligned tracklist');
  }

  await recordManualSubmission(
    `human:${session.user.name}`,
    errorReportDraftFromMisaligned(gap, disposition),
    options,
  );
  return getContributions();
}

/**
 * Observe whether a recorded contradiction is still in the cache.
 *
 * Reads only. If MusicBrainz still maps the ISRC to several recordings, or
 * the tracklists still disagree, the row stays pending. Applied only when the
 * cache no longer shows the contradiction — never by deleting our copy of it.
 */
export async function recheckErrorReport(
  kind: 'contested_isrc' | 'misaligned_tracklist',
  key: string,
) {
  await checkAuth();
  const stillPresent =
    kind === 'contested_isrc'
      ? Boolean((await contestedIsrcs(5_000)).find((row) => row.isrc === key))
      : Boolean((await misalignedAlbums(5_000)).find((album) => album.albumId === key));

  if (!stillPresent) {
    await db
      .update(mbSubmission)
      .set({ outcome: 'applied', outcomeAt: new Date() })
      .where(
        and(
          eq(mbSubmission.kind, 'error'),
          eq(mbSubmission.outcome, 'pending'),
          kind === 'contested_isrc' ? eq(mbSubmission.value, key) : eq(mbSubmission.subject, key),
        ),
      );
  }

  return { stillPresent, view: await getContributions() };
}

/**
 * Fetch a confirmed new work into the cache. Does not submit anything to
 * MusicBrainz. Applied only if the cache then holds a full work; a miss or a
 * stub stays pending, and a missing edit ID stays missing.
 */
export async function recheckCreatedWork(workMbid: string) {
  await checkAuth();
  const mbid = requireMbid(workMbid, 'The work');
  const [confirmed] = await db
    .select({ id: mbSubmission.id })
    .from(mbSubmission)
    .where(and(eq(mbSubmission.kind, 'work'), eq(mbSubmission.targetMbid, mbid)))
    .limit(1);
  if (!confirmed) {
    throw new ManualSubmissionError('That work has no creation confirmation');
  }

  const { requests } = await ingestWorkTree(musicBrainzApi('interactive'), mbid);
  const [cached] = await db
    .select({ detail: mbWork.detail })
    .from(mbWork)
    .where(eq(mbWork.mbid, mbid));
  const state = createdWorkCacheState(cached ?? null);
  if (createdWorkLanded(state)) {
    await db
      .update(mbSubmission)
      .set({ outcome: 'applied', outcomeAt: new Date() })
      .where(
        and(
          eq(mbSubmission.kind, 'work'),
          eq(mbSubmission.targetMbid, mbid),
          eq(mbSubmission.outcome, 'pending'),
        ),
      );
  }

  return { state, requests, view: await getContributions() };
}

export async function setSubmissionOutcome(
  id: number,
  outcome: 'pending' | 'applied' | 'rejected' | 'withdrawn',
  editId?: string,
) {
  await checkAuth();
  await db
    .update(mbSubmission)
    .set({ outcome, outcomeAt: new Date(), editId: editId ?? null })
    .where(eq(mbSubmission.id, id));
  return getContributions();
}

/**
 * Observe every pending ledger row against the cache, and close the ones
 * MusicBrainz now shows.
 *
 * Cheap and read-only: a later ingest is what brings the fact back, and
 * nothing is marked applied on our say-so. Missing edit IDs stay missing.
 * Unfetched streaming URL relations stay pending rather than counting as
 * landed.
 */
export async function reconcileSubmissions() {
  await checkAuth();

  async function applyWhere(
    kind: 'isrc' | 'barcode' | 'work_relationship' | 'work' | 'release',
    landed: ReturnType<typeof sql>,
  ) {
    return db
      .update(mbSubmission)
      .set({ outcome: 'applied', outcomeAt: new Date() })
      .where(and(eq(mbSubmission.kind, kind), eq(mbSubmission.outcome, 'pending'), landed))
      .returning({ id: mbSubmission.id });
  }

  const [isrc, barcodes, workRelationships, works, releases] = await Promise.all([
    applyWhere(
      'isrc',
      sql`exists (
        select 1 from mb_recording_isrc
        where mb_recording_isrc.recording_mbid = ${mbSubmission.targetMbid}
          and mb_recording_isrc.isrc = ${mbSubmission.value}
      )`,
    ),
    applyWhere(
      'barcode',
      sql`exists (
        select 1 from mb_release
        where mb_release.mbid = ${mbSubmission.targetMbid}
          and mb_release.barcode is not null
          and mb_release.barcode <> ''
      )`,
    ),
    applyWhere(
      'work_relationship',
      sql`exists (
        select 1 from mb_recording_work
        where mb_recording_work.recording_mbid = ${mbSubmission.targetMbid}
          and mb_recording_work.work_mbid = ${mbSubmission.value}
      )`,
    ),
    applyWhere(
      'work',
      sql`exists (
        select 1 from mb_work
        where mb_work.mbid = ${mbSubmission.targetMbid}
          and mb_work.detail = 'full'
      )`,
    ),
    applyWhere(
      'release',
      sql`exists (
        select 1 from spotify_album
        where spotify_album.spotify_id = ${mbSubmission.subject}
          and spotify_album.mb_release_id is not null
      )`,
    ),
  ]);

  const pendingStreaming = await db
    .select({ targetMbid: mbSubmission.targetMbid })
    .from(mbSubmission)
    .where(and(eq(mbSubmission.kind, 'streaming_url'), eq(mbSubmission.outcome, 'pending')));
  const streamingMbids = [
    ...new Set(
      pendingStreaming
        .map((row) => row.targetMbid)
        .filter((mbid): mbid is string => typeof mbid === 'string'),
    ),
  ];
  const streamingLanded: string[] = [];
  for (const mbid of streamingMbids) {
    if (cachedStreamingUrlLanded(await observeSpotifyFreeStreamingUrlState(mbid))) {
      streamingLanded.push(mbid);
    }
  }
  const streaming =
    streamingLanded.length === 0
      ? []
      : await db
          .update(mbSubmission)
          .set({ outcome: 'applied', outcomeAt: new Date() })
          .where(
            and(
              eq(mbSubmission.kind, 'streaming_url'),
              eq(mbSubmission.outcome, 'pending'),
              inArray(mbSubmission.targetMbid, streamingLanded),
            ),
          )
          .returning({ id: mbSubmission.id });

  const pendingErrors = await db
    .select({
      id: mbSubmission.id,
      subject: mbSubmission.subject,
      value: mbSubmission.value,
      evidence: mbSubmission.evidence,
    })
    .from(mbSubmission)
    .where(and(eq(mbSubmission.kind, 'error'), eq(mbSubmission.outcome, 'pending')));
  const [stillContested, stillMisaligned] = await Promise.all([
    contestedIsrcs(5_000),
    misalignedAlbums(5_000),
  ]);
  const contestedIsrcsStill = new Set(stillContested.map((row) => row.isrc));
  const misalignedStill = new Set(stillMisaligned.map((album) => album.albumId));
  const errorLanded = pendingErrors.filter((row) => {
    const problem = (row.evidence as { problem?: unknown } | null)?.problem;
    if (problem === 'contested_isrc') {
      return typeof row.value === 'string' && !contestedIsrcsStill.has(row.value);
    }
    if (problem === 'misaligned_tracklist') {
      return !misalignedStill.has(row.subject);
    }
    return false;
  });
  const errors =
    errorLanded.length === 0
      ? []
      : await db
          .update(mbSubmission)
          .set({ outcome: 'applied', outcomeAt: new Date() })
          .where(
            and(
              eq(mbSubmission.kind, 'error'),
              eq(mbSubmission.outcome, 'pending'),
              inArray(
                mbSubmission.id,
                errorLanded.map((row) => row.id),
              ),
            ),
          )
          .returning({ id: mbSubmission.id });

  return {
    applied:
      isrc.length +
      barcodes.length +
      workRelationships.length +
      works.length +
      releases.length +
      streaming.length +
      errors.length,
    view: await getContributions(),
  };
}
