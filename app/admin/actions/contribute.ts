'use server';

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mbSubmission } from '@/lib/db/schema';
import {
  barcodeGaps,
  contestedIsrcs,
  contributionCounts,
  harmonyImportLink,
  isrcGapsByRelease,
  magicIsrcLink,
  missingReleases,
  releaseEditLink,
  workRelationshipGaps,
  type IsrcGap,
} from '@/lib/musicbrainz-contributions';
import { editsSpentToday, MusicBrainzBotError, runIsrcBot } from '@/lib/musicbrainz-bot';
import { botCredentials } from '@/lib/musicbrainz-oauth';
import { checkAuth } from './auth';

/**
 * What the bot would submit, without submitting it.
 *
 * Separate from the submit action on purpose. Every batch is looked at
 * before it is sent: the evidence is shown, the edit note is shown, and the
 * payload is available to read. Automation is something each class of edit
 * earns, and for now the earning is somebody deciding one batch at a time.
 */
export type BotPreview = {
  configured: boolean;
  spentToday: number;
  dailyCap: number;
  edits: number;
  editNote: string;
  payload: string;
  items: { isrc: string; recordingMbid: string }[];
  error: string | null;
};

export async function previewBotBatch(maxEdits = 25): Promise<BotPreview> {
  await checkAuth();
  const configured = botCredentials() !== null;
  try {
    const run = await runIsrcBot({ apply: false, maxEdits });
    return {
      configured,
      spentToday: run.spentToday,
      dailyCap: 1000,
      edits: run.edits,
      editNote: run.editNote,
      payload: run.payload,
      items: run.items,
      error: null,
    };
  } catch (error) {
    return {
      configured,
      spentToday: await editsSpentToday().catch(() => 0),
      dailyCap: 1000,
      edits: 0,
      editNote: '',
      payload: '',
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send one batch, because a person asked for this batch.
 *
 * The bot is never run on a schedule and never by the worker. It submits
 * when somebody presses the button, so that every edit leaving here has been
 * looked at by the person whose name is on the account.
 */
export async function submitBotBatch(
  maxEdits = 25,
): Promise<{ submitted: number; error: string | null; view: ContributionView }> {
  await checkAuth();
  try {
    const run = await runIsrcBot({ apply: true, maxEdits });
    return { submitted: run.edits, error: null, view: await getContributions() };
  } catch (error) {
    const message =
      error instanceof MusicBrainzBotError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { submitted: 0, error: message, view: await getContributions() };
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
    tracks: { isrc: string; medium: number; position: number; title: string; delta: number }[];
  }[];
  workGaps: Awaited<ReturnType<typeof workRelationshipGaps>>;
  contested: Awaited<ReturnType<typeof contestedIsrcs>>;
  missing: (Awaited<ReturnType<typeof missingReleases>>[number] & { harmony: string })[];
  barcodes: (Awaited<ReturnType<typeof barcodeGaps>>[number] & { edit: string })[];
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

  const [counts, releases, workGaps, contested, missing, barcodes, recent] = await Promise.all([
    contributionCounts(),
    isrcGapsByRelease(40),
    workRelationshipGaps(40),
    contestedIsrcs(20),
    missingReleases(40),
    barcodeGaps(20),
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

  return {
    counts,
    isrcReleases: releases.map((release) => ({
      releaseMbid: release.releaseMbid,
      albumId: release.albumId,
      albumTitle: release.albumTitle,
      missing: release.missing,
      link: magicIsrcLink(release.releaseMbid, release.gaps),
      tracks: release.gaps.map((gap: IsrcGap) => ({
        isrc: gap.isrc,
        medium: gap.medium,
        position: gap.position,
        title: gap.recordingTitle,
        delta: gap.durationDeltaMs,
      })),
    })),
    workGaps,
    contested,
    missing: missing.map((album) => ({ ...album, harmony: harmonyImportLink(album.albumId) })),
    barcodes: barcodes.map((gap) => ({ ...gap, edit: releaseEditLink(gap.releaseMbid) })),
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
