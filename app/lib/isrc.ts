/**
 * The one spelling of an ISRC we store and compare.
 *
 * ISRCs are case-insensitive, but SQL string equality is not. MusicBrainz
 * always writes them uppercase; Spotify occasionally returns them lowercase.
 * Storing Spotify's spelling verbatim made those tracks fail every join
 * against `mb_recording_isrc` — they read as gaps after MusicBrainz already
 * had the ISRC, and their submissions never reconciled. Every writer of an
 * ISRC goes through this so the comparison can stay a plain `=`.
 */
export function normalizeIsrc(isrc: string): string;
export function normalizeIsrc(isrc: string | null | undefined): string | null;
export function normalizeIsrc(isrc: string | null | undefined): string | null {
  const normalized = isrc?.trim().toUpperCase();
  return normalized ? normalized : null;
}
