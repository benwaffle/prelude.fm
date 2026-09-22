/**
 * Evidence packages for human-confirmed MusicBrainz submissions.
 *
 * Opening an editor is not a submission. These drafts are written to the
 * ledger only after the person returns and explicitly confirms that they
 * submitted the edit. Keeping their construction pure makes the evidence and
 * dedupe identity reviewable without a database or a MusicBrainz account.
 *
 * Two constraints shape every builder here:
 *
 * - `value` is never null, because the ledger's dedupe is a SQLite unique
 *   index over (kind, target_mbid, value) and SQLite treats nulls as
 *   distinct. A nullable column there would silently stop deduplicating, and
 *   the cross-user dedupe is the reason the index exists.
 * - `targetMbid` is null only when MusicBrainz genuinely has no entity yet. A
 *   class that has several plausible targets picks one deterministically
 *   rather than leaving the identity blank; the rest stay in the evidence.
 */

export type ManualSubmissionKind =
  | 'barcode'
  | 'streaming_url'
  | 'release'
  | 'work'
  | 'work_relationship'
  | 'error';

export type ManualSubmissionDraft = {
  kind: ManualSubmissionKind;
  targetMbid: string | null;
  subject: string;
  /** Always non-null so the ledger's unique identity also works in SQLite. */
  value: string;
  evidence: Record<string, unknown>;
};

/** A confirmation we will not accept, with a message meant for the editor. */
export class ManualSubmissionError extends Error {}

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * An MBID out of whatever the person had on their clipboard.
 *
 * They have just created a work and the thing they can copy is the page's
 * address, so a bare UUID and an entity URL are both accepted. Anything else
 * returns null: guessing at a malformed identifier would write a ledger row
 * pointing at nothing, and the row is the only record that the edit happened.
 */
export function normalizeMbid(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  const fromUrl = /musicbrainz\.org\/[a-z-]+\/([0-9a-f-]{36})/.exec(trimmed);
  const candidate = fromUrl ? fromUrl[1] : trimmed;
  return MBID_PATTERN.test(candidate) ? candidate : null;
}

export function requireMbid(input: string, label: string): string {
  const mbid = normalizeMbid(input);
  if (!mbid) throw new ManualSubmissionError(`${label} is not a MusicBrainz identifier`);
  return mbid;
}

/**
 * An MBID the person may not have yet.
 *
 * Empty input is absence. Present input must still be a real identifier: a
 * malformed one would write a ledger row pointing at nothing.
 */
export function optionalMbid(input: string | null | undefined, label: string): string | null {
  if (input == null || input.trim() === '') return null;
  return requireMbid(input, label);
}

/**
 * The edit number, when the person has it.
 *
 * Optional on purpose, and missing stays missing: an edit ID is how an
 * outcome is later checked against MusicBrainz, so inventing one would make a
 * submission look verifiable when it is not. Empty input is absence; input
 * that is present but not an edit number is an error worth reporting.
 */
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

/** The three fields the ledger's unique index dedupes on. */
export function submissionIdentity(draft: ManualSubmissionDraft): string {
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

/** The exact facts retained when a person says they submitted a barcode. */
export function barcodeSubmissionDraft(gap: BarcodeSubmissionGap): ManualSubmissionDraft {
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

export type WorkCandidateEvidence =
  | 'existing_mb_part_link'
  | 'existing_mb_work_link'
  | 'catalogue_match';

export type WorkRelationshipSubmission = {
  recordingMbid: string;
  recordingTitle: string;
  albumId: string;
  albumTitle: string;
  /** The work the person says they linked the recording to. */
  workMbid: string;
  workTitle: string;
  workType: string | null;
  composerMbid: string | null;
  composerName: string | null;
  catalogues: { system: string; number: string }[];
  /** Why this work was offered as a candidate, kept verbatim. */
  candidateEvidence: WorkCandidateEvidence[];
};

/**
 * A recording-to-work relationship somebody added by hand.
 *
 * The work MBID is the dedupe value rather than the recording, because the
 * same recording can legitimately gain several work relationships — a medley
 * is one recording of three works — and one confirmation should not hide the
 * next.
 *
 * `candidateEvidence` records what we offered, not what the person checked.
 * A catalogue match identifies a plausible work; it never proved that this
 * performance is of it, and the ledger should not later read as though it
 * did.
 */
export function workRelationshipDraft(
  submission: WorkRelationshipSubmission,
): ManualSubmissionDraft {
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

/**
 * Confirm a relationship only against a candidate we actually offered.
 *
 * The work MBID is taken from the person; everything else is re-read from the
 * gap so a confirmation cannot smuggle a title or catalogue that was never on
 * the MusicBrainz candidate. A work we did not offer is refused rather than
 * recorded as if we had identified it.
 */
export function workRelationshipDraftFromGap(
  gap: WorkRelationshipGapInput,
  workMbidInput: string,
): ManualSubmissionDraft {
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

/** Ledger readout: outcome plus the edit number, or that the number is missing. */
export function describeLedgerState(entry: { outcome: string; editId: string | null }): string {
  return entry.editId
    ? `${entry.outcome} · edit ${entry.editId}`
    : `${entry.outcome} · edit ID missing`;
}

export type WorkCreationSubmission = {
  /** The recording the missing work was blocking, so the re-ingest has a start. */
  recordingMbid: string;
  recordingTitle: string;
  albumId: string;
  albumTitle: string;
  /** The MBID MusicBrainz assigned to the newly created work. */
  workMbid: string;
  /**
   * What we showed the person as copy-ready evidence.
   *
   * Retained exactly as proposed, including its legacy provenance, so a later
   * reader can tell that the title in this row was a parser's reading and not
   * something MusicBrainz told us.
   */
  proposal: {
    localWorkId: number;
    title: string;
    type: string | null;
    composerName: string;
    composerMbid: string | null;
    catalogues: { system: string; number: string }[];
    provenance: 'legacy_proposal';
  } | null;
};

/**
 * A work the person created upstream, recorded by its new MBID.
 *
 * The MBID is required rather than optional: without it there is nothing to
 * re-ingest and no way to check the work exists, and a ledger row for a work
 * we cannot name would be an assertion that an edit happened with no way to
 * confirm it.
 */
export function workCreationDraft(submission: WorkCreationSubmission): ManualSubmissionDraft {
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
      /** Proposal, not MusicBrainz fact — see WorkCreationSubmission. */
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
  proposals: NonNullable<WorkCreationSubmission['proposal']>[];
};

/**
 * Confirm a newly created work against the recording it was blocking.
 *
 * The MBID is the person's; without a valid one there is nothing to re-ingest.
 * The proposal is copied from what this recording showed, never invented, and
 * stays labelled a proposal. Several proposals stay several: we do not pick
 * one and call it the work they created.
 */
export function workCreationDraftFromGap(
  gap: WorkCreationGapInput,
  workMbidInput: string,
  localWorkId?: number,
): ManualSubmissionDraft {
  const workMbid = requireMbid(workMbidInput, 'The new work');
  let proposal: WorkCreationSubmission['proposal'] = null;
  if (localWorkId != null) {
    proposal = gap.proposals.find((row) => row.localWorkId === localWorkId) ?? null;
    if (!proposal) {
      throw new ManualSubmissionError('That proposal is not on this recording');
    }
  } else if (gap.proposals.length === 1) {
    proposal = gap.proposals[0];
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
      shownProposals: gap.proposals,
    },
  };
}

/** What the cache knows about a created work after a re-ingest, not before. */
export function createdWorkCacheState(
  work: { detail: 'stub' | 'full' } | null,
): 'missing' | 'stub' | 'full' {
  return work?.detail ?? 'missing';
}

/** Only a full fetch is MusicBrainz showing the work; a stub is still a hole. */
export function createdWorkLanded(state: 'missing' | 'stub' | 'full'): boolean {
  return state === 'full';
}

export type ReleaseSubmission = {
  albumId: string;
  albumTitle: string;
  year: number | null;
  upc: string | null;
  trackCount: number;
  /** Why we could not find a release, as the console showed it. */
  reason: string;
  /**
   * The release MusicBrainz created, when the person has it to hand.
   *
   * Often absent: Harmony's submission goes into the edit queue and the MBID
   * may not exist yet. The Spotify album URL then carries the ledger identity,
   * which is stable and is the thing the submission was made from.
   */
  releaseMbid: string | null;
};

export function releaseSubmissionDraft(submission: ReleaseSubmission): ManualSubmissionDraft {
  const spotifyUrl = `https://open.spotify.com/album/${submission.albumId}`;
  return {
    kind: 'release',
    /**
     * The unique index is (kind, target_mbid, value). A null target would
     * make SQLite treat every confirmation as distinct, so the Spotify URL
     * stands in for the release that does not exist yet. The resulting MBID,
     * when the person has it, stays in evidence rather than changing the
     * identity and opening a second row.
     */
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

/**
 * Confirm a Harmony submission against the album we still cannot place.
 *
 * The Spotify album URL is the ledger identity. A resulting release MBID is
 * optional: Harmony often queues the edit before MusicBrainz has assigned one.
 */
export function releaseSubmissionDraftFromGap(
  gap: MissingReleaseGapInput,
  releaseMbidInput?: string | null,
): ManualSubmissionDraft {
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

/**
 * What the person did about a contradiction, not what MusicBrainz decided.
 *
 * Both values mean an upstream action exists to be reconciled later. A
 * contradiction nobody could act on deliberately has no disposition: it stays
 * in the console as an open row, because the alternative is a ledger entry
 * that reads like a submission and closes a gap we have not closed.
 */
export type ErrorDisposition = 'reported' | 'fixed';

export type ContestedIsrcReport = {
  kind: 'contested_isrc';
  isrc: string;
  /** Every recording MusicBrainz maps the ISRC to. */
  recordingMbids: string[];
  titles: string;
  /** The Spotify track that showed us the conflict, when we hold one. */
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
  mismatches: {
    position: number;
    ourTitle: string | null;
    ourMs: number | null;
    theirTitle: string | null;
    theirMs: number | null;
  }[];
};

export type ErrorReport = ContestedIsrcReport | MisalignedTracklistReport;

/**
 * A contradiction somebody raised upstream.
 *
 * A contested ISRC has no single target: several recordings hold it and the
 * report is about all of them. The lowest MBID is used as the ledger identity
 * — deterministic, and a real one of the contested recordings — while the
 * evidence keeps every side. Leaving the target null instead would break the
 * dedupe index, and then one report per visit.
 */
export function errorReportDraft(
  report: ErrorReport,
  disposition: ErrorDisposition,
): ManualSubmissionDraft {
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
        identityNote: 'Ledger identity only; the report concerns every recording listed.',
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
