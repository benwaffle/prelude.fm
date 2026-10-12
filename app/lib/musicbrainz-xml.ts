/** Pure, so payloads can be tested without credentials or risk of posting. */

/** The code of conduct asks every edit to say who runs the bot. */
export const BOT_CONTACT = process.env.MUSICBRAINZ_CONTACT ?? 'https://prelude.fm';

export const BOT_SIGNATURE = `Submitted by prelude_fm_bot, operated by ${BOT_CONTACT}. Replies to this note are read.`;

export function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (char) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] as string,
  );
}

/** Below a second, milliseconds: "0.0s" reads like a rounding artefact. */
export function describeDelta(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// The edit note travels inside the document (XPath /mb:metadata/mb:edit-note), not as a query
// parameter.
export function metadataDocument(list: string, entries: string, editNote: string): string {
  const note = editNote.trim() ? `  <edit-note>${escapeXml(editNote.trim())}</edit-note>\n` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<metadata xmlns="http://musicbrainz.org/ns/mmd-2.0#">\n` +
    `  <${list}>\n${entries}\n  </${list}>\n` +
    note +
    `</metadata>\n`
  );
}
