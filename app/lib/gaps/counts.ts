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
import { wholeWorkLinks } from './whole-work-links';

// Every gap on these albums (a window: `album-window`), never the whole library.
export async function gapLists(albumIds: readonly string[]) {
  const scope = { albumIds };
  const [isrc, work, contested, missing, barcodes, streaming, misaligned, wholeWork] =
    await Promise.all([
      isrcGaps(scope),
      workRelationshipGaps(scope),
      contestedIsrcs(scope),
      missingReleases(scope),
      barcodeGaps(scope),
      streamingUrlGaps(scope),
      misalignedAlbums(scope),
      wholeWorkLinks(scope),
    ]);
  return { isrc, work, contested, missing, barcodes, streaming, misaligned, wholeWork };
}

export type GapLists = Awaited<ReturnType<typeof gapLists>>;

export async function submissionCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ outcome: mbSubmission.outcome, n: sql<number>`count(*)` })
    .from(mbSubmission)
    .groupBy(mbSubmission.outcome);
  return Object.fromEntries(rows.map((row) => [row.outcome, row.n]));
}

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
    wholeWork: lists.wholeWork.length,
    submissions,
  };
}

export type ContributionCounts = ReturnType<typeof countContributions>;

export async function contributionCounts(albumIds: readonly string[]): Promise<ContributionCounts> {
  const [lists, submissions] = await Promise.all([gapLists(albumIds), submissionCounts()]);
  return countContributions(lists, submissions);
}
