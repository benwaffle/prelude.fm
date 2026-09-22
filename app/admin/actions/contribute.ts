'use server';

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mbSubmission, mbWork } from '@/lib/db/schema';
import {
  barcodeGaps,
  contestedIsrcs,
  contributionCounts,
  harmonyImportLink,
  isrcGapsByRelease,
  magicIsrcLink,
  misalignedAlbums,
  missingReleases,
  releaseEditLink,
  recordingEditLink,
  workCreateLink,
  workRelationshipGaps,
  type IsrcGap,
} from '@/lib/musicbrainz-contributions';
import { editsSpentToday, MusicBrainzBotError, runIsrcBot } from '@/lib/musicbrainz-bot';
import { botCredentials } from '@/lib/musicbrainz-oauth';
import { musicBrainzApi } from '@/lib/musicbrainz';
import { ingestWorkTree } from '@/lib/musicbrainz-cache';
import {
  barcodeSubmissionDraft,
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

export type ContributionView = {
  counts: Awaited<ReturnType<typeof contributionCounts>>;
  isrcReleases: {
    releaseMbid: string;
    albumId: string;
    albumTitle: string;
    missing: number;
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
    ledger: {
      id: number;
      outcome: string;
      editId: string | null;
      releaseMbid: string | null;
      label: string;
    } | null;
  })[];
  barcodes: (Awaited<ReturnType<typeof barcodeGaps>>[number] & { edit: string })[];
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

export async function getContributions(): Promise<ContributionView> {
  await checkAuth();

  const [counts, releases, workGaps, contested, missing, barcodes, misaligned, recent] =
    await Promise.all([
      contributionCounts(),
      isrcGapsByRelease(40),
      workRelationshipGaps(40),
      contestedIsrcs(20),
      missingReleases(40),
      barcodeGaps(20),
      misalignedAlbums(30),
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
  const releaseLedgerRows =
    missingAlbumIds.length === 0
      ? []
      : await db
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
          );
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

  return {
    counts,
    isrcReleases: releases.map((release) => ({
      releaseMbid: release.releaseMbid,
      albumId: release.albumId,
      albumTitle: release.albumTitle,
      missing: release.missing,
      link: magicIsrcLink(release.releaseMbid, release.gaps),
      barcode: release.gaps[0]?.barcode ?? null,
      upc: release.gaps[0]?.upc ?? null,
      tracks: release.gaps.map((gap: IsrcGap) => ({
        isrc: gap.isrc,
        medium: gap.medium,
        position: gap.position,
        trackTitle: gap.trackTitle,
        recordingTitle: gap.recordingTitle,
        recordingMbid: gap.recordingMbid,
        upc: gap.upc,
        barcode: gap.barcode,
        delta: gap.durationDeltaMs,
      })),
    })),
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
      ledger: releaseLedgerByAlbum.get(album.albumId) ?? null,
    })),
    barcodes: barcodes.map((gap) => ({ ...gap, edit: releaseEditLink(gap.releaseMbid) })),
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
export async function recordIsrcSubmission(releaseMbid: string, note?: string) {
  const session = await checkAuth();
  const submitter = `human:${session.user.name}`;

  const releases = await isrcGapsByRelease(500);
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
        note: note ?? null,
      })
      .onConflictDoNothing();
  }

  return getContributions();
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
  if (!gap) throw new Error('That release has no outstanding barcode contribution');

  await recordManualSubmission(`human:${session.user.name}`, barcodeSubmissionDraft(gap), options);
  return getContributions();
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
 * Re-check what MusicBrainz now holds for the recordings we submitted ISRCs
 * for, and close the ones that landed.
 *
 * Cheap, because the cache already knows: if a later release read brought the
 * ISRC back, the edit was accepted. Nothing is marked applied on our say-so.
 */
export async function reconcileSubmissions() {
  await checkAuth();
  const applied = await db
    .update(mbSubmission)
    .set({ outcome: 'applied', outcomeAt: new Date() })
    .where(
      and(
        eq(mbSubmission.kind, 'isrc'),
        eq(mbSubmission.outcome, 'pending'),
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
