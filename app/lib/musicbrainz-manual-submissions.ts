/**
 * Evidence packages for human-confirmed MusicBrainz submissions.
 *
 * Opening an editor is not a submission. These drafts are written to the
 * ledger only after the person returns and explicitly confirms that they
 * submitted the edit. Keeping their construction pure makes the evidence and
 * dedupe identity reviewable without a database or a MusicBrainz account.
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
