// ISRCs are case-insensitive but SQL equality is not; Spotify sometimes returns lowercase. Every
// writer normalises so comparisons can stay a plain `=`.
export function normalizeIsrc(isrc: string): string;
export function normalizeIsrc(isrc: string | null | undefined): string | null;
export function normalizeIsrc(isrc: string | null | undefined): string | null {
  const normalized = isrc?.trim().toUpperCase();
  return normalized ? normalized : null;
}
