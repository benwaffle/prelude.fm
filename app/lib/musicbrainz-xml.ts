/**
 * The pieces every prelude_fm_bot submission document shares.
 *
 * MusicBrainz takes ISRCs and barcodes as an XML `<metadata>` document with
 * one list and an optional edit note. Pure, so payloads can be tested without
 * credentials and without the risk of a test posting to somebody else's
 * database.
 */

/** Who runs the bot, which the code of conduct asks every edit to say. */
export const BOT_CONTACT = process.env.MUSICBRAINZ_CONTACT ?? 'https://prelude.fm';

/** The last paragraph of every bot edit note. */
export const BOT_SIGNATURE = `Submitted by prelude_fm_bot, operated by ${BOT_CONTACT}. Replies to this note are read.`;

export function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (char) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] as string,
  );
}

/**
 * The worst duration difference, in the unit that does not misrepresent it.
 *
 * Rounding 1ms to "0.0s" reads like a rounding artefact and invites the
 * suspicion that the number is decorative; below a second, milliseconds say
 * what actually happened.
 */
export function describeDelta(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * A submission document: one list element around `entries`, then the note.
 *
 * The edit note travels inside the document, not as a query parameter. The
 * server reads it with the XPath /mb:metadata/mb:edit-note — which is why the
 * first ISRC version submitted edits with no note at all: the note was built,
 * stored in our ledger, and never sent.
 */
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
