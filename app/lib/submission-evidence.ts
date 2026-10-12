// `parseEvidence` is the one place stored JSON is probed; fields a row predates come back null, not
// guessed. No database import, so the client can share the types.
import type { mbSubmission } from './db/schema';

export type SubmissionKind = (typeof mbSubmission.$inferSelect)['kind'];
export type SubmissionOutcome = (typeof mbSubmission.$inferSelect)['outcome'];

type Catalogue = { system: string; number: string };

export type WorkCandidateEvidence =
  | 'existing_mb_part_link'
  | 'existing_mb_work_link'
  | 'catalogue_match'
  | 'same_release_recording'
  | 'work_link_proposal';

/** Copy-ready evidence for a new work; never MusicBrainz fact. */
export type WorkProposalEvidence = {
  localWorkId: number;
  title: string;
  type: string | null;
  composerName: string;
  composerMbid: string | null;
  catalogues: Catalogue[];
  provenance: 'legacy_proposal';
};

export type ErrorDisposition = 'reported' | 'fixed';

export type TracklistMismatch = {
  position: number;
  ourTitle: string | null;
  ourMs: number | null;
  theirTitle: string | null;
  theirMs: number | null;
};

export type EvidenceByKind = {
  isrc: {
    releaseMbid: string;
    barcode: string | null;
    medium: number;
    position: number;
    durationDeltaMs: number;
    matchedBy: string;
  };
  barcode: {
    releaseTitle: string;
    spotifyAlbumId: string;
    spotifyUrl: string;
    musicbrainzUrl: string;
    spotifyBarcode: string;
    musicbrainzBarcodeBefore: null;
    verifiedTrackCount: number;
    maxDurationDeltaMs: number;
    durationToleranceMs: number;
  };
  work_relationship: {
    recordingMbid: string;
    recordingTitle: string;
    recordingUrl: string;
    workMbid: string;
    workTitle: string;
    workType: string | null;
    workUrl: string;
    composerMbid: string | null;
    composerName: string | null;
    catalogues: Catalogue[];
    candidateEvidence: WorkCandidateEvidence[];
    spotifyAlbumId: string;
    spotifyAlbumTitle: string;
    spotifyUrl: string;
    confirmedBy: 'human';
  };
  work: {
    workMbid: string;
    workUrl: string;
    recordingMbid: string;
    recordingTitle: string;
    recordingUrl: string;
    spotifyAlbumId: string;
    spotifyAlbumTitle: string;
    spotifyUrl: string;
    proposal: WorkProposalEvidence | null;
    /** Every proposal the recording showed, when the confirmation came from a gap. */
    shownProposals?: WorkProposalEvidence[];
    confirmedBy: 'human';
  };
  release: {
    spotifyAlbumId: string;
    spotifyAlbumTitle: string;
    spotifyUrl: string;
    spotifyYear: number | null;
    spotifyBarcode: string | null;
    spotifyTrackCount: number;
    lookupFailureReason: string;
    releaseMbid: string | null;
    releaseUrl: string | null;
    confirmedBy: 'human';
  };
  streaming_url: {
    gapCode: string;
    relationshipTypeId: string;
    relationshipType: 'free streaming';
    releaseMbid: string;
    releaseTitle: string;
    releaseUrl: string;
    releaseEditUrl: string;
    spotifyAlbumId: string;
    spotifyAlbumTitle: string;
    spotifyUrl: string;
    confirmedBy: 'human';
  };
  error:
    | {
        problem: 'contested_isrc';
        disposition: ErrorDisposition;
        isrc: string;
        recordingMbids: string[];
        recordingUrls: string[];
        recordingTitles: string;
        identityRecordingMbid: string;
        identityNote: string;
        confirmedBy: 'human';
      }
    | {
        problem: 'misaligned_tracklist';
        disposition: ErrorDisposition;
        spotifyAlbumId: string;
        spotifyAlbumTitle: string;
        spotifyUrl: string;
        releaseMbid: string;
        releaseUrl: string;
        diagnosis: string;
        ourTrackCount: number;
        theirTrackCount: number;
        mismatches: TracklistMismatch[];
        confirmedBy: 'human';
      };
};

// `value` is never null: the dedupe index is (kind, target_mbid, value) and SQLite treats nulls as
// distinct. `targetMbid` is null only when MusicBrainz has no entity yet; several plausible targets
// pick one deterministically.
export type SubmissionDraft = {
  [K in SubmissionKind]: {
    kind: K;
    targetMbid: string | null;
    subject: string;
    value: string;
    evidence: EvidenceByKind[K];
  };
}[SubmissionKind];

/** `kind: 'error'` is split by the report's own `problem`, so no reader probes it. */
export type SubmissionEvidence =
  | { kind: 'isrc'; releaseMbid: string | null }
  | { kind: 'release'; releaseMbid: string | null }
  | { kind: 'work'; recordingMbid: string | null }
  | { kind: 'barcode' }
  | { kind: 'streaming_url' }
  | { kind: 'work_relationship' }
  | {
      kind: 'error';
      problem: 'contested_isrc';
      disposition: string | null;
      recordingMbids: string[];
    }
  | {
      kind: 'error';
      problem: 'misaligned_tracklist';
      disposition: string | null;
      releaseMbid: string | null;
    }
  /** A report whose problem this code does not know; read, never acted on. */
  | { kind: 'error'; problem: null; disposition: string | null };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => text(entry) ?? []) : [];
}

export function parseEvidence(kind: SubmissionKind, json: unknown): SubmissionEvidence {
  const evidence: Record<string, unknown> =
    json !== null && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  switch (kind) {
    case 'isrc':
    case 'release':
      return { kind, releaseMbid: text(evidence.releaseMbid) };
    case 'work':
      return { kind, recordingMbid: text(evidence.recordingMbid) };
    case 'barcode':
    case 'streaming_url':
    case 'work_relationship':
      return { kind };
    case 'error': {
      const disposition = text(evidence.disposition);
      if (evidence.problem === 'contested_isrc') {
        return {
          kind,
          problem: 'contested_isrc',
          disposition,
          recordingMbids: texts(evidence.recordingMbids),
        };
      }
      if (evidence.problem === 'misaligned_tracklist') {
        return {
          kind,
          problem: 'misaligned_tracklist',
          disposition,
          releaseMbid: text(evidence.releaseMbid),
        };
      }
      return { kind, problem: null, disposition };
    }
  }
}
