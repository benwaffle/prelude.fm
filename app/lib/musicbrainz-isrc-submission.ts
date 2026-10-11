/**
 * Building an ISRC submission for MusicBrainz.
 *
 * The payload and the eligibility rule live apart from anything that sends
 * them, so both can be tested without credentials and without the risk of a
 * test posting to somebody else's database.
 *
 * MusicBrainz takes ISRCs as an XML document listing recordings and the ISRCs
 * to attach to each. One request can carry many, which matters for the daily
 * cap: the bot code of conduct limits a bot to 1,000 *edits* a day, and each
 * ISRC is an edit even when fifty of them travel in one request. Counting
 * requests would let one POST spend fifty times its share.
 */

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

/**
 * The XML document MusicBrainz expects.
 *
 * Grouped by recording, because a recording can legitimately carry several
 * ISRCs — the same performance issued in two territories — and the format
 * nests them under one `<recording>` element.
 */
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

/** How many edits a submission costs, which is what the daily cap counts. */
export function editCount(items: IsrcSubmissionItem[]): number {
  const pairs = new Set(
    items
      .filter((item) => isWellFormedIsrc(item.isrc))
      .map((item) => `${item.recordingMbid}:${item.isrc.trim().toUpperCase()}`),
  );
  return pairs.size;
}

/**
 * The note attached to every edit.
 *
 * The code of conduct asks that a bot be identifiable, say where its data
 * comes from, and give a way to reach whoever runs it — and that somebody
 * answers when an editor replies.
 */
export function editNoteFor(gaps: IsrcGap[]): string {
  const [first] = gaps;
  if (!first) return '';

  const worst = Math.max(...gaps.map((gap) => gap.durationDeltaMs));
  const source = `https://open.spotify.com/album/${first.albumId}`;

  /*
   * The two barcodes are the same number written two ways — Spotify pads a
   * UPC-12 to thirteen digits — so the note says both rather than picking
   * one and calling it the other. An editor comparing the Spotify page
   * against this release should find the difference already explained.
   */
  const ours = first.upc ?? 'unknown';
  const theirs = first.barcode ?? 'none';
  const barcodes =
    ours.replace(/^0+/, '') === theirs.replace(/^0+/, '') && ours !== theirs
      ? `barcode ${ours} (this release: ${theirs} — the same barcode without the leading zero)`
      : `barcode ${ours}`;

  /*
   * Written so another editor can check the claim rather than take it. The
   * barcode is what ties the two releases together, the Spotify link is the
   * source the ISRCs came from, the release link is the MusicBrainz side of
   * that pairing, and the worst duration difference bounds the
   * whole batch — an editor who disagrees can open all three and see.
   *
   * It deliberately does not restate which ISRC went where: the edit itself
   * shows that, and a note repeating it is noise in somebody else's review
   * queue.
   */
  return [
    `${gaps.length} ISRC(s) from the Spotify release with ${barcodes}.`,
    `Source: ${source}`,
    `Release: https://musicbrainz.org/release/${first.releaseMbid}`,
    `Each ISRC is taken from the Spotify track at the same disc and track position; every track's duration agrees with MusicBrainz to within ${describeDelta(worst)} (tolerance 3s).`,
    BOT_SIGNATURE,
  ].join('\n\n');
}
