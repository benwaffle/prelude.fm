// Pure, so payloads can be tested without credentials. The daily cap counts edits, and each ISRC is
// one edit even when fifty share a request.

import type { IsrcGap } from './musicbrainz-edit-links';
import { BOT_SIGNATURE, describeDelta, escapeXml, metadataDocument } from './musicbrainz-xml';

export type IsrcSubmissionItem = {
  recordingMbid: string;
  isrc: string;
};

/** MusicBrainz rejects a malformed ISRC outright; better to catch it here. */
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

export function isWellFormedIsrc(isrc: string): boolean {
  return ISRC_PATTERN.test(isrc.trim().toUpperCase());
}

/** Grouped by recording: one performance can carry several ISRCs (two territories). */
export function buildIsrcSubmission(items: IsrcSubmissionItem[], editNote = ''): string {
  const byRecording = new Map<string, Set<string>>();
  for (const item of items) {
    const isrc = item.isrc.trim().toUpperCase();
    if (!isWellFormedIsrc(isrc)) continue;
    const set = byRecording.get(item.recordingMbid) ?? new Set<string>();
    set.add(isrc);
    byRecording.set(item.recordingMbid, set);
  }

  const recordings = [...byRecording.entries()]
    .map(([mbid, isrcs]) => {
      const list = [...isrcs].map((isrc) => `        <isrc id="${escapeXml(isrc)}" />`).join('\n');
      return (
        `    <recording id="${escapeXml(mbid)}">\n` +
        `      <isrc-list count="${isrcs.size}">\n${list}\n      </isrc-list>\n` +
        `    </recording>`
      );
    })
    .join('\n');

  return metadataDocument('recording-list', recordings, editNote);
}

export function editCount(items: IsrcSubmissionItem[]): number {
  const pairs = new Set(
    items
      .filter((item) => isWellFormedIsrc(item.isrc))
      .map((item) => `${item.recordingMbid}:${item.isrc.trim().toUpperCase()}`),
  );
  return pairs.size;
}

/** The code of conduct asks a bot to be identifiable, cite its source and be reachable. */
export function editNoteFor(gaps: IsrcGap[]): string {
  const [first] = gaps;
  if (!first) return '';

  const worst = Math.max(...gaps.map((gap) => gap.durationDeltaMs));
  const source = `https://open.spotify.com/album/${first.albumId}`;

  // Spotify pads a UPC-12 to thirteen digits, so the note gives both rather than calling one the
  // other.
  const ours = first.upc ?? 'unknown';
  const theirs = first.barcode ?? 'none';
  const barcodes =
    ours.replace(/^0+/, '') === theirs.replace(/^0+/, '') && ours !== theirs
      ? `barcode ${ours} (this release: ${theirs} — the same barcode without the leading zero)`
      : `barcode ${ours}`;

  // Enough for another editor to check the claim; which ISRC went where is in the edit itself.
  return [
    `${gaps.length} ISRC(s) from the Spotify release with ${barcodes}.`,
    `Source: ${source}`,
    `Release: https://musicbrainz.org/release/${first.releaseMbid}`,
    `Each ISRC is taken from the Spotify track at the same disc and track position; every track's duration agrees with MusicBrainz to within ${describeDelta(worst)} (tolerance 3s).`,
    BOT_SIGNATURE,
  ].join('\n\n');
}
