import type { BarcodeGap } from './gaps/barcodes';
import { BOT_SIGNATURE, describeDelta, escapeXml, metadataDocument } from './musicbrainz-xml';

export type BarcodeSubmissionItem = {
  releaseMbid: string;
  barcode: string;
};

// The note is sent though MusicBrainz's barcode handler ignores <edit-note> (MBS-14476); the Inbox
// shows it for adding by hand.
export function buildBarcodeSubmission(items: BarcodeSubmissionItem[], editNote = ''): string {
  const releases = items
    .map(
      (item) =>
        `    <release id="${escapeXml(item.releaseMbid)}">\n` +
        `      <barcode>${escapeXml(item.barcode.trim())}</barcode>\n` +
        `    </release>`,
    )
    .join('\n');
  return metadataDocument('release-list', releases, editNote);
}

export function editCount(items: BarcodeSubmissionItem[]): number {
  return new Set(items.map((item) => `${item.releaseMbid}:${item.barcode.trim()}`)).size;
}

export function editNoteFor(gaps: BarcodeGap[]): string {
  if (gaps.length === 0) return '';

  const worst = Math.max(...gaps.map((gap) => gap.maxDurationDeltaMs));

  if (gaps.length === 1) {
    const gap = gaps[0];
    return [
      `Barcode ${gap.barcode} from the Spotify album matched to this release by title and duration (${gap.trackCount} tracks, worst duration difference ${describeDelta(gap.maxDurationDeltaMs)}, tolerance 5s).`,
      `Source: https://open.spotify.com/album/${gap.albumId}`,
      `Release: https://musicbrainz.org/release/${gap.releaseMbid}`,
      BOT_SIGNATURE,
    ].join('\n\n');
  }

  return [
    `${gaps.length} barcodes from Spotify albums matched to MusicBrainz releases by title and duration (worst duration difference ${describeDelta(worst)}, tolerance 5s).`,
    gaps
      .map(
        (gap) =>
          `- ${gap.releaseTitle}: https://open.spotify.com/album/${gap.albumId} → https://musicbrainz.org/release/${gap.releaseMbid}`,
      )
      .join('\n'),
    BOT_SIGNATURE,
  ].join('\n\n');
}
