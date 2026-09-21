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

export type IsrcSubmissionItem = {
  recordingMbid: string;
  isrc: string;
};

/** MusicBrainz rejects a malformed ISRC outright; better to catch it here. */
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

export function isWellFormedIsrc(isrc: string): boolean {
  return ISRC_PATTERN.test(isrc.trim().toUpperCase());
}

const escapeXml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (char) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] as string,
  );

/**
 * The XML document MusicBrainz expects.
 *
 * Grouped by recording, because a recording can legitimately carry several
 * ISRCs — the same performance issued in two territories — and the format
 * nests them under one `<recording>` element.
 */
export function buildIsrcSubmission(items: IsrcSubmissionItem[]): string {
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

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<metadata xmlns="http://musicbrainz.org/ns/mmd-2.0#">\n` +
    `  <recording-list>\n${recordings}\n  </recording-list>\n` +
    `</metadata>\n`
  );
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
