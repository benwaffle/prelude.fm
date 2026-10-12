'use server';

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { forChunks } from '@/lib/db/chunked';
import { db } from '@/lib/db';
import { mbSubmission, mbWorkProposal } from '@/lib/db/schema';
import {
  BLOCKING_OUTCOMES,
  ManualSubmissionError,
  requireMbid,
  workRelationshipDraft,
} from '@/lib/musicbrainz-manual-submissions';
import { insertSubmissions } from '@/lib/submission-ledger';
import { loadProposalGaps } from '@/lib/work-proposals-run';
import {
  proposalAlbums,
  type ProposalAlbumView,
  type ProposalCounts,
  type ProposalStatus,
} from '@/lib/work-proposals-view';
import { checkAuth } from './auth';

export type WorkProposalsView = {
  albums: ProposalAlbumView[];
  counts: ProposalCounts;
};

async function loadView(): Promise<WorkProposalsView> {
  const gaps = await loadProposalGaps();
  const recordingMbids = gaps.map((gap) => gap.recordingMbid);
  const [stored, recorded] =
    recordingMbids.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              recordingMbid: mbWorkProposal.recordingMbid,
              proposal: mbWorkProposal.proposal,
              status: mbWorkProposal.status,
            })
            .from(mbWorkProposal)
            .where(inArray(mbWorkProposal.recordingMbid, recordingMbids)),
          forChunks(recordingMbids, (chunk) =>
            db
              .select({ recordingMbid: mbSubmission.targetMbid })
              .from(mbSubmission)
              .where(
                and(
                  eq(mbSubmission.kind, 'work_relationship'),
                  inArray(mbSubmission.targetMbid, chunk),
                  inArray(mbSubmission.outcome, [...BLOCKING_OUTCOMES]),
                ),
              ),
          ),
        ]);
  return proposalAlbums(
    gaps,
    stored,
    new Set(recorded.flatMap((row) => (row.recordingMbid ? [row.recordingMbid] : []))),
  );
}

export async function getWorkProposals(): Promise<WorkProposalsView> {
  await checkAuth();
  return loadView();
}

/** Deciding writes nothing outside this table. */
export async function decideWorkProposals(
  recordingMbidsInput: string[],
  status: ProposalStatus,
): Promise<WorkProposalsView> {
  await checkAuth();
  if (!['proposed', 'approved', 'dismissed'].includes(status)) {
    throw new ManualSubmissionError('Unknown decision');
  }
  const recordingMbids = [
    ...new Set(recordingMbidsInput.map((mbid) => requireMbid(mbid, 'The recording'))),
  ];
  if (recordingMbids.length > 0) {
    await db
      .update(mbWorkProposal)
      .set({ status, decidedAt: status === 'proposed' ? null : new Date() })
      .where(
        and(
          inArray(mbWorkProposal.recordingMbid, recordingMbids),
          isNotNull(mbWorkProposal.proposal),
        ),
      );
  }
  return loadView();
}

/** Submits nothing; Recheck reads MusicBrainz to see whether each link landed. */
export async function recordEnteredWorkLinks(albumId: string): Promise<WorkProposalsView> {
  const session = await checkAuth();
  const view = await loadView();
  const album = view.albums.find((candidate) => candidate.albumId === albumId);
  const approved = album?.rows.filter((row) => row.state === 'approved' && row.proposal) ?? [];
  if (!album || approved.length === 0) {
    throw new ManualSubmissionError('That album has no approved work links to record');
  }
  await insertSubmissions(
    approved.map((row) => {
      const proposal = row.proposal!;
      return {
        ...workRelationshipDraft({
          recordingMbid: row.recordingMbid,
          recordingTitle: row.title,
          albumId: album.albumId,
          albumTitle: album.albumTitle,
          workMbid: proposal.workMbid,
          workTitle: proposal.parentTitle
            ? `${proposal.parentTitle}: ${proposal.title}`
            : proposal.title,
          workType: null,
          composerMbid: null,
          composerName: proposal.composerName,
          catalogues: [],
          candidateEvidence: ['work_link_proposal'],
        }),
        note: `Approved from a ${proposal.confidence}-confidence proposal: ${proposal.reasons.join(' ')}`,
      };
    }),
    { submittedBy: `human:${session.user.name}` },
  );
  return loadView();
}
