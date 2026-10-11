import { sql } from 'drizzle-orm';
import { db } from '../db';
import { mbSubmission } from '../db/schema';
import { barcodeGaps } from './barcodes';
import { contestedIsrcs } from './contested';
import { isrcGaps } from './isrc';
import { misalignedAlbums } from './misaligned';
import { missingReleases } from './missing-releases';
import { streamingUrlGaps } from './streaming-urls';
import { workRelationshipGaps } from './work-relationships';

/** Every gap class, read whole: the counts and each section's page come from one read. */
export async function gapLists() {
  const [isrc, work, contested, missing, barcodes, streaming, misaligned] = await Promise.all([
    isrcGaps(),
    workRelationshipGaps(),
    contestedIsrcs(),
    missingReleases(),
    barcodeGaps(),
    streamingUrlGaps(),
    misalignedAlbums(),
  ]);
  return { isrc, work, contested, missing, barcodes, streaming, misaligned };
}

export type GapLists = Awaited<ReturnType<typeof gapLists>>;

/** How many ledger rows have each outcome. */
export async function submissionCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ outcome: mbSubmission.outcome, n: sql<number>`count(*)` })
    .from(mbSubmission)
    .groupBy(mbSubmission.outcome);
  return Object.fromEntries(rows.map((row) => [row.outcome, row.n]));
}

/** How much of each kind of contribution is waiting, from lists already read. */
export function countContributions(lists: GapLists, submissions: Record<string, number>) {
  return {
    isrc: lists.isrc.length,
    isrcReleases: new Set(lists.isrc.map((row) => row.releaseMbid)).size,
    workRelationships: lists.work.length,
    contestedIsrcs: lists.contested.length,
    missingReleases: lists.missing.length,
    barcodes: lists.barcodes.length,
    streamingUrls: lists.streaming.length,
    misaligned: lists.misaligned.length,
    submissions,
  };
}

export type ContributionCounts = ReturnType<typeof countContributions>;

/** How much of each kind of contribution is waiting. */
export async function contributionCounts(): Promise<ContributionCounts> {
  const [lists, submissions] = await Promise.all([gapLists(), submissionCounts()]);
  return countContributions(lists, submissions);
}
