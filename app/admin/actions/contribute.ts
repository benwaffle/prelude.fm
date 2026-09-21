'use server';

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mbSubmission } from '@/lib/db/schema';
import {
  contestedIsrcs,
  contributionCounts,
  isrcGapsByRelease,
  magicIsrcLink,
  workRelationshipGaps,
  type IsrcGap,
} from '@/lib/musicbrainz-contributions';
import { checkAuth } from './auth';

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

  const [counts, releases, workGaps, contested, recent] = await Promise.all([
    contributionCounts(),
    isrcGapsByRelease(40),
    workRelationshipGaps(40),
    contestedIsrcs(20),
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
