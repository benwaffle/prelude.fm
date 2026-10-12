// Drafts are ledgered only after the person confirms they submitted the edit; opening an editor is
// not a submission.
import type { IsrcGap } from './musicbrainz-edit-links';
import { normalizeIsrc } from './isrc';
import type {
  ErrorDisposition,
  SubmissionDraft,
  SubmissionKind,
  TracklistMismatch,
  WorkCandidateEvidence,
  WorkProposalEvidence,
} from './submission-evidence';

export type { ErrorDisposition, WorkCandidateEvidence } from './submission-evidence';

export type DraftOf<K extends SubmissionKind> = Extract<SubmissionDraft, { kind: K }>;

export class ManualSubmissionError extends Error {}

const MBID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MBID_PATTERN = new RegExp(`^${MBID}$`);

// A bare UUID or an entity URL; anything else is null, since a guessed MBID would ledger a row
// pointing at nothing.
export function normalizeMbid(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  const fromUrl = /musicbrainz\.org\/[a-z-]+\/([0-9a-f-]{36})/.exec(trimmed);
  const candidate = fromUrl ? fromUrl[1] : trimmed;
  return MBID_PATTERN.test(candidate) ? candidate : null;
}

/** Looser than `normalizeMbid`, so only for reads: it never decides a ledger identity. */
export function findMbid(input: string): string | null {
  return new RegExp(MBID, 'i').exec(input)?.[0].toLowerCase() ?? null;
}

export function requireMbid(input: string, label: string): string {
  const mbid = normalizeMbid(input);
  if (!mbid) throw new ManualSubmissionError(`${label} is not a MusicBrainz identifier`);
  return mbid;
}

/** Empty input is absence; a malformed one would write a ledger row pointing at nothing. */
export function optionalMbid(input: string | null | undefined, label: string): string | null {
  if (input == null || input.trim() === '') return null;
  return requireMbid(input, label);
}

// Missing stays missing: an invented edit ID would make a submission look verifiable when it is
// not.
export function normalizeEditId(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const fromUrl = /musicbrainz\.org\/edit\/(\d+)/.exec(trimmed.toLowerCase());
  const candidate = fromUrl ? fromUrl[1] : trimmed;
  if (!/^\d+$/.test(candidate)) {
    throw new ManualSubmissionError('An edit ID is the number MusicBrainz shows for the edit');
  }
  return candidate;
}

export function submissionIdentity(draft: SubmissionDraft): string {
  return `${draft.kind}\u0000${draft.targetMbid ?? ''}\u0000${draft.value}`;
}

export type BarcodeSubmissionGap = {
  releaseMbid: string;
  releaseTitle: string;
  albumId: string;
  barcode: string;
  trackCount: number;
  maxDurationDeltaMs: number;
};

export function barcodeSubmissionDraft(gap: BarcodeSubmissionGap): DraftOf<'barcode'> {
  const spotifyUrl = `https://open.spotify.com/album/${gap.albumId}`;
  const musicbrainzUrl = `https://musicbrainz.org/release/${gap.releaseMbid}`;
  return {
    kind: 'barcode',
    targetMbid: gap.releaseMbid,
    subject: gap.albumId,
    value: gap.barcode,
    evidence: {
      releaseTitle: gap.releaseTitle,
      spotifyAlbumId: gap.albumId,
      spotifyUrl,
      musicbrainzUrl,
      spotifyBarcode: gap.barcode,
      musicbrainzBarcodeBefore: null,
      verifiedTrackCount: gap.trackCount,
      maxDurationDeltaMs: gap.maxDurationDeltaMs,
      durationToleranceMs: 5_000,
    },
  };
}

export type WorkRelationshipSubmission = {
  recordingMbid: string;
  recordingTitle: string;
  albumId: string;
  albumTitle: string;
  workMbid: string;
  workTitle: string;
  workType: string | null;
  composerMbid: string | null;
  composerName: string | null;
  catalogues: { system: string; number: string }[];
  /** Kept verbatim. */
  candidateEvidence: WorkCandidateEvidence[];
};

/**
 * The work MBID is the dedupe value: one recording can gain several work relationships (a medley).
 * `candidateEvidence` records what we offered, not what the person checked.
 */
export function workRelationshipDraft(
  submission: WorkRelationshipSubmission,
): DraftOf<'work_relationship'> {
  return {
    kind: 'work_relationship',
    targetMbid: submission.recordingMbid,
    subject: submission.albumId,
    value: submission.workMbid,
    evidence: {
      recordingMbid: submission.recordingMbid,
      recordingTitle: submission.recordingTitle,
      recordingUrl: `https://musicbrainz.org/recording/${submission.recordingMbid}`,
      workMbid: submission.workMbid,
      workTitle: submission.workTitle,
      workType: submission.workType,
      workUrl: `https://musicbrainz.org/work/${submission.workMbid}`,
      composerMbid: submission.composerMbid,
      composerName: submission.composerName,
      catalogues: submission.catalogues,
      candidateEvidence: submission.candidateEvidence,
      spotifyAlbumId: submission.albumId,
      spotifyAlbumTitle: submission.albumTitle,
      spotifyUrl: `https://open.spotify.com/album/${submission.albumId}`,
      confirmedBy: 'human',
    },
  };
}

export type WorkRelationshipGapInput = {
  recordingMbid: string;
  recordingTitle: string;
  albumId: string;
  albumTitle: string;
  candidates: Array<{
    workMbid: string;
    title: string;
    type: string | null;
    composerMbid: string | null;
    composerName: string | null;
    catalogues: { system: string; number: string }[];
    evidence: WorkCandidateEvidence[];
  }>;
};

// Everything but the work MBID is re-read from the gap, so a confirmation cannot smuggle in a
// candidate we never offered.
export function workRelationshipDraftFromGap(
  gap: WorkRelationshipGapInput,
  workMbidInput: string,
): DraftOf<'work_relationship'> {
  const workMbid = requireMbid(workMbidInput, 'The work');
  const candidate = gap.candidates.find((row) => row.workMbid === workMbid);
  if (!candidate) {
    throw new ManualSubmissionError('That work is not a MusicBrainz candidate for this recording');
  }
  return workRelationshipDraft({
    recordingMbid: gap.recordingMbid,
    recordingTitle: gap.recordingTitle,
    albumId: gap.albumId,
    albumTitle: gap.albumTitle,
    workMbid: candidate.workMbid,
    workTitle: candidate.title,
    workType: candidate.type,
    composerMbid: candidate.composerMbid,
    composerName: candidate.composerName,
    catalogues: candidate.catalogues,
    candidateEvidence: candidate.evidence,
  });
}

export function describeLedgerState(entry: { outcome: string; editId: string | null }): string {
  return entry.editId
    ? `${entry.outcome} · edit ${entry.editId}`
    : `${entry.outcome} · edit ID missing`;
}

// Only these block offering the edit again; a rejected or withdrawn submission is history and its
// gap returns.
export const BLOCKING_OUTCOMES = ['pending', 'applied'] as const;

export const BATCH_BLOCKING_OUTCOMES = [...BLOCKING_OUTCOMES, 'rejected'] as const;

export function blocksResubmission(outcome: string): boolean {
  return (BLOCKING_OUTCOMES as readonly string[]).includes(outcome);
}

export function splitSubmissionHistory<T extends { id: number; outcome: string }>(
  rows: readonly T[],
): { current: T | null; previous: T | null } {
  let current: T | null = null;
  let previous: T | null = null;
  for (const row of rows) {
    if (blocksResubmission(row.outcome)) {
      if (!current || row.id > current.id) current = row;
    } else if (!previous || row.id > previous.id) {
      previous = row;
    }
  }
  return { current, previous };
}

export function submissionHistoryBy<T extends { id: number; outcome: string }>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
): Map<string, { current: T | null; previous: T | null }> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return new Map([...grouped].map(([key, list]) => [key, splitSubmissionHistory(list)]));
}

export function describePreviousSubmission(entry: {
  outcome: string;
  editId: string | null;
}): string {
  return entry.editId
    ? `${entry.outcome} before (edit ${entry.editId})`
    : `${entry.outcome} before (edit ID missing)`;
}

// Voters turned it down, so only an explicit per-row click resubmits it. A withdrawn edit counts as
// fresh.
export function needsExplicitResubmission(previous: { outcome: string } | null): boolean {
  return previous?.outcome === 'rejected';
}

export type WorkCreationSubmission = {
  recordingMbid: string;
  recordingTitle: string;
  albumId: string;
  albumTitle: string;
  workMbid: string;
  // Retained exactly as proposed, including legacy provenance, so a parser's title is never
  // mistaken for MusicBrainz's.
  proposal: WorkProposalEvidence | null;
};

// The MBID is required: without it there is nothing to re-ingest and no way to confirm the work
// exists.
export function workCreationDraft(submission: WorkCreationSubmission): DraftOf<'work'> {
  return {
    kind: 'work',
    targetMbid: submission.workMbid,
    subject: submission.albumId,
    value: submission.workMbid,
    evidence: {
      workMbid: submission.workMbid,
      workUrl: `https://musicbrainz.org/work/${submission.workMbid}`,
      recordingMbid: submission.recordingMbid,
      recordingTitle: submission.recordingTitle,
      recordingUrl: `https://musicbrainz.org/recording/${submission.recordingMbid}`,
      spotifyAlbumId: submission.albumId,
      spotifyAlbumTitle: submission.albumTitle,
      spotifyUrl: `https://open.spotify.com/album/${submission.albumId}`,
      proposal: submission.proposal,
      confirmedBy: 'human',
    },
  };
}

export type WorkCreationGapInput = {
  recordingMbid: string;
  recordingTitle: string;
  albumId: string;
  albumTitle: string;
  proposals?: WorkProposalEvidence[];
};

/** The proposal is copied, never invented, and several proposals stay several. */
export function workCreationDraftFromGap(
  gap: WorkCreationGapInput,
  workMbidInput: string,
  localWorkId?: number,
): DraftOf<'work'> {
  const workMbid = requireMbid(workMbidInput, 'The new work');
  let proposal: WorkCreationSubmission['proposal'] = null;
  if (localWorkId != null) {
    proposal = (gap.proposals ?? []).find((row) => row.localWorkId === localWorkId) ?? null;
    if (!proposal) {
      throw new ManualSubmissionError('That proposal is not on this recording');
    }
  } else if ((gap.proposals ?? []).length === 1) {
    proposal = gap.proposals![0];
  }
  const draft = workCreationDraft({
    recordingMbid: gap.recordingMbid,
    recordingTitle: gap.recordingTitle,
    albumId: gap.albumId,
    albumTitle: gap.albumTitle,
    workMbid,
    proposal,
  });
  return {
    ...draft,
    evidence: {
      ...draft.evidence,
      shownProposals: gap.proposals ?? [],
    },
  };
}

export type ReleaseSubmission = {
  albumId: string;
  albumTitle: string;
  year: number | null;
  upc: string | null;
  trackCount: number;
  reason: string;
  /** Often absent: Harmony's edit may be queued before MusicBrainz assigns an MBID. */
  releaseMbid: string | null;
};

export function releaseSubmissionDraft(submission: ReleaseSubmission): DraftOf<'release'> {
  const spotifyUrl = `https://open.spotify.com/album/${submission.albumId}`;
  return {
    kind: 'release',
    // The unique index is (kind, target_mbid, value) and SQLite treats null targets as distinct, so
    // the Spotify URL stands in for the release that does not exist yet.
    targetMbid: spotifyUrl,
    subject: submission.albumId,
    /** Always the album URL: stable whether or not the MBID exists yet. */
    value: spotifyUrl,
    evidence: {
      spotifyAlbumId: submission.albumId,
      spotifyAlbumTitle: submission.albumTitle,
      spotifyUrl,
      spotifyYear: submission.year,
      spotifyBarcode: submission.upc,
      spotifyTrackCount: submission.trackCount,
      lookupFailureReason: submission.reason,
      releaseMbid: submission.releaseMbid,
      releaseUrl: submission.releaseMbid
        ? `https://musicbrainz.org/release/${submission.releaseMbid}`
        : null,
      confirmedBy: 'human',
    },
  };
}

export type MissingReleaseGapInput = {
  albumId: string;
  albumTitle: string;
  year: number | null;
  upc: string | null;
  tracks: number;
  reason: string;
};

// A resulting release MBID is optional: Harmony often queues the edit before MusicBrainz assigns
// one.
export function releaseSubmissionDraftFromGap(
  gap: MissingReleaseGapInput,
  releaseMbidInput?: string | null,
): DraftOf<'release'> {
  return releaseSubmissionDraft({
    albumId: gap.albumId,
    albumTitle: gap.albumTitle,
    year: gap.year,
    upc: gap.upc,
    trackCount: gap.tracks,
    reason: gap.reason,
    releaseMbid: optionalMbid(releaseMbidInput, 'The new release'),
  });
}

export type ContestedIsrcReport = {
  kind: 'contested_isrc';
  isrc: string;
  recordingMbids: string[];
  titles: string;
  albumId: string | null;
};

export type MisalignedTracklistReport = {
  kind: 'misaligned_tracklist';
  albumId: string;
  albumTitle: string;
  releaseMbid: string;
  diagnosis: string;
  ourTrackCount: number;
  theirTrackCount: number;
  /** Both sides of each disagreeing position, never collapsed to a verdict. */
  mismatches: TracklistMismatch[];
};

export type ErrorReport = ContestedIsrcReport | MisalignedTracklistReport;

// A contested ISRC has no single target; the lowest MBID is a deterministic identity, since a null
// target would break the dedupe index.
export function errorReportDraft(
  report: ErrorReport,
  disposition: ErrorDisposition,
): DraftOf<'error'> {
  if (report.kind === 'contested_isrc') {
    const recordings = [...report.recordingMbids].sort();
    if (recordings.length === 0) {
      throw new ManualSubmissionError('A contested ISRC report needs the recordings it contests');
    }
    return {
      kind: 'error',
      targetMbid: recordings[0],
      subject: report.albumId ?? report.isrc,
      value: report.isrc,
      evidence: {
        problem: 'contested_isrc',
        disposition,
        isrc: report.isrc,
        recordingMbids: recordings,
        recordingUrls: recordings.map((mbid) => `https://musicbrainz.org/recording/${mbid}`),
        recordingTitles: report.titles,
        identityRecordingMbid: recordings[0],
        identityNote:
          'Stored against the first recording only; the report concerns every recording listed.',
        confirmedBy: 'human',
      },
    };
  }

  return {
    kind: 'error',
    targetMbid: report.releaseMbid,
    subject: report.albumId,
    value: report.albumId,
    evidence: {
      problem: 'misaligned_tracklist',
      disposition,
      spotifyAlbumId: report.albumId,
      spotifyAlbumTitle: report.albumTitle,
      spotifyUrl: `https://open.spotify.com/album/${report.albumId}`,
      releaseMbid: report.releaseMbid,
      releaseUrl: `https://musicbrainz.org/release/${report.releaseMbid}`,
      diagnosis: report.diagnosis,
      ourTrackCount: report.ourTrackCount,
      theirTrackCount: report.theirTrackCount,
      mismatches: report.mismatches,
      confirmedBy: 'human',
    },
  };
}

// What the person did, not what MusicBrainz decided. A contradiction nobody acted on stays an open
// row rather than a ledger entry.
export function requireErrorDisposition(input: string): ErrorDisposition {
  if (input === 'reported' || input === 'fixed') return input;
  throw new ManualSubmissionError('A contradiction is reported or fixed, not guessed away');
}

export type ContestedIsrcGapInput = {
  isrc: string;
  recordingMbids: string[];
  titles: string;
  albumId?: string | null;
};

export function errorReportDraftFromContested(
  gap: ContestedIsrcGapInput,
  dispositionInput: string,
): DraftOf<'error'> {
  return errorReportDraft(
    {
      kind: 'contested_isrc',
      isrc: gap.isrc,
      recordingMbids: gap.recordingMbids,
      titles: gap.titles,
      albumId: gap.albumId ?? null,
    },
    requireErrorDisposition(dispositionInput),
  );
}

export type MisalignedTracklistGapInput = {
  albumId: string;
  albumTitle: string;
  releaseMbid: string;
  diagnosis: { kind: string };
  ourCount: number;
  theirCount: number;
  mismatches: MisalignedTracklistReport['mismatches'];
};

export function errorReportDraftFromMisaligned(
  gap: MisalignedTracklistGapInput,
  dispositionInput: string,
): DraftOf<'error'> {
  return errorReportDraft(
    {
      kind: 'misaligned_tracklist',
      albumId: gap.albumId,
      albumTitle: gap.albumTitle,
      releaseMbid: gap.releaseMbid,
      diagnosis: gap.diagnosis.kind,
      ourTrackCount: gap.ourCount,
      theirTrackCount: gap.theirCount,
      mismatches: gap.mismatches,
    },
    requireErrorDisposition(dispositionInput),
  );
}

/** A track URL already present counts as present, not a gap, matching the library reader. */
export const SPOTIFY_FREE_STREAMING_RELATIONSHIP_TYPE_ID = '08445ccf-7b99-4438-9f9a-fb9ac18099ee';

/** Only emitted when URL relations were fetched and none match. */
export const RELEASE_SPOTIFY_STREAMING_URL_MISSING = 'release-spotify-streaming-url-missing';

export type ReleaseUrlRelation = {
  url: string;
  relationshipTypeId: string;
  ended: boolean | number;
};

export type SpotifyFreeStreamingUrlState = 'unknown' | 'present' | 'missing';

export function isSpotifyFreeStreamingRelation(relation: ReleaseUrlRelation): boolean {
  if (
    relation.ended ||
    relation.relationshipTypeId !== SPOTIFY_FREE_STREAMING_RELATIONSHIP_TYPE_ID
  ) {
    return false;
  }
  try {
    return new URL(relation.url).hostname.toLowerCase() === 'open.spotify.com';
  } catch {
    return false;
  }
}

// `unknown` if URL relations were never fetched (an empty list is not absence); only `missing` is a
// contribution.
export function spotifyFreeStreamingUrlState(input: {
  urlRelationsFetchedAt: Date | string | number | null | undefined;
  relations: ReleaseUrlRelation[];
}): SpotifyFreeStreamingUrlState {
  if (input.urlRelationsFetchedAt == null) return 'unknown';
  return input.relations.some(isSpotifyFreeStreamingRelation) ? 'present' : 'missing';
}

export function isStreamingUrlContributionGap(state: SpotifyFreeStreamingUrlState): boolean {
  return state === 'missing';
}

export function spotifyAlbumUrl(albumId: string): string {
  return `https://open.spotify.com/album/${albumId}`;
}

export type StreamingUrlSubmission = {
  releaseMbid: string;
  releaseTitle: string;
  albumId: string;
  albumTitle: string;
};

// The value is the exact submitted URL, which also distinguishes several albums sharing a release.
export function streamingUrlDraft(submission: StreamingUrlSubmission): DraftOf<'streaming_url'> {
  const spotifyUrl = spotifyAlbumUrl(submission.albumId);
  return {
    kind: 'streaming_url',
    targetMbid: submission.releaseMbid,
    subject: submission.albumId,
    value: spotifyUrl,
    evidence: {
      gapCode: RELEASE_SPOTIFY_STREAMING_URL_MISSING,
      relationshipTypeId: SPOTIFY_FREE_STREAMING_RELATIONSHIP_TYPE_ID,
      relationshipType: 'free streaming',
      releaseMbid: submission.releaseMbid,
      releaseTitle: submission.releaseTitle,
      releaseUrl: `https://musicbrainz.org/release/${submission.releaseMbid}`,
      releaseEditUrl: `https://musicbrainz.org/release/${submission.releaseMbid}/edit`,
      spotifyAlbumId: submission.albumId,
      spotifyAlbumTitle: submission.albumTitle,
      spotifyUrl,
      confirmedBy: 'human',
    },
  };
}

export function isrcSubmissionDraft(gap: IsrcGap): DraftOf<'isrc'> {
  return {
    kind: 'isrc',
    targetMbid: gap.recordingMbid,
    subject: gap.spotifyTrackId,
    value: normalizeIsrc(gap.isrc),
    evidence: {
      releaseMbid: gap.releaseMbid,
      barcode: gap.barcode,
      medium: gap.medium,
      position: gap.position,
      durationDeltaMs: gap.durationDeltaMs,
      matchedBy: gap.matchedBy,
    },
  };
}
