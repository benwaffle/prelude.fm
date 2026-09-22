/**
 * Building a barcode submission for MusicBrainz.
 *
 * Same separation as ISRC submission: payload and eligibility live apart from
 * anything that sends them, so both can be tested without credentials.
 *
 * MusicBrainz accepts barcodes as an XML document listing releases and the
 * barcode to attach to each. One request can carry many; the bot code of
 * conduct counts each barcode as one edit.
 */

import type { BarcodeGap } from './musicbrainz-contributions';

const contact = process.env.MUSICBRAINZ_CONTACT ?? 'https://prelude.fm';

export type BarcodeSubmissionItem = {
  releaseMbid: string;
  barcode: string;
};

const escapeXml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (char) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] as string,
  );

/** The XML document MusicBrainz expects for release barcodes. */
export function buildBarcodeSubmission(items: BarcodeSubmissionItem[], editNote = ''): string {
  const releases = items
    .map(
      (item) =>
        `    <release id="${escapeXml(item.releaseMbid)}">\n` +
        `      <barcode>${escapeXml(item.barcode.trim())}</barcode>\n` +
        `    </release>`,
    )
    .join('\n');

  const note = editNote.trim() ? `  <edit-note>${escapeXml(editNote.trim())}</edit-note>\n` : '';

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<metadata xmlns="http://musicbrainz.org/ns/mmd-2.0#">\n` +
    `  <release-list>\n${releases}\n  </release-list>\n` +
    note +
    `</metadata>\n`
  );
}

/** How many edits a submission costs, which is what the daily cap counts. */
export function editCount(items: BarcodeSubmissionItem[]): number {
  return new Set(items.map((item) => `${item.releaseMbid}:${item.barcode.trim()}`)).size;
}

function describeDelta(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The note attached to every barcode edit. */
export function editNoteFor(gaps: BarcodeGap[]): string {
  if (gaps.length === 0) return '';

  const worst = Math.max(...gaps.map((gap) => gap.maxDurationDeltaMs));

  if (gaps.length === 1) {
    const gap = gaps[0];
    return [
      `Barcode ${gap.barcode} from the Spotify album matched to this release by title and duration (${gap.trackCount} tracks, worst duration difference ${describeDelta(gap.maxDurationDeltaMs)}, tolerance 5s).`,
      `Source: https://open.spotify.com/album/${gap.albumId}`,
      `Release: https://musicbrainz.org/release/${gap.releaseMbid}`,
      `Submitted by prelude_fm_bot, operated by ${contact}. Replies to this note are read.`,
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
    `Submitted by prelude_fm_bot, operated by ${contact}. Replies to this note are read.`,
  ].join('\n\n');
}
