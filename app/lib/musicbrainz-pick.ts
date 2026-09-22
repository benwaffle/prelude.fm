/**
 * An in-app MusicBrainz search-results row.
 *
 * Ambiguous links — several releases sharing a barcode, several works that
 * could be the recording relationship — should be picked here, the way the
 * MusicBrainz editor lists hits, rather than by sending the person to a
 * generic search page. Opening a hit is still not a ledger write. Confirm is.
 *
 * Fields we do not hold stay blank. The disambiguation comment and physical
 * format are the usual absences: the cache never stored them, so the picker
 * does not invent them.
 */

export const AMBIGUOUS_BARCODE_REASON = 'several releases share the barcode';

export type MbPickHit = {
  entity: 'release' | 'work';
  mbid: string;
  title: string;
  /** Artist credit or composer. */
  credit: string | null;
  date: string | null;
  country: string | null;
  /** Work type, or track/medium counts for a release. */
  detail: string | null;
  catalogues: string[];
  comment: string | null;
  href: string;
};

/**
 * What attaching a picked release to the Spotify album would take.
 *
 * Confirmation in the Inbox only ledgers. Writing `spotify_album.mbReleaseId`
 * and ingesting the chosen release are cache/schema work the integrator owns.
 */
export type PickedReleaseAttachRequest = {
  albumId: string;
  releaseMbid: string;
};

export type PickedReleaseAttachOutcome =
  | { attached: true; releaseMbid: string }
  | {
      attached: false;
      reason: 'album_not_found' | 'album_already_matched' | 'release_not_in_cache';
    };

export function normalisePickBarcode(value: string | null | undefined): string | null {
  const barcode = value?.trim().replace(/^0+/, '');
  return barcode ? barcode : null;
}

/** Advanced search for this barcode, not a generic MusicBrainz search box. */
export function barcodeReleaseSearchUrl(upc: string): string {
  const barcode = normalisePickBarcode(upc) ?? upc.trim();
  const query = new URLSearchParams({
    type: 'release',
    method: 'advanced',
    query: `barcode:${barcode}`,
  });
  return `https://musicbrainz.org/search?${query.toString()}`;
}

export function formatMbPickMeta(hit: MbPickHit): string {
  return [hit.credit, hit.date, hit.country, hit.detail, ...hit.catalogues, hit.comment]
    .filter((part): part is string => Boolean(part && part.trim() !== ''))
    .join(' · ');
}

export function mbReleasePickHit(input: {
  mbid: string;
  title: string;
  date: string | null;
  country: string | null;
  artistNames: string[];
  trackCount: number;
  mediumCount: number;
  comment?: string | null;
}): MbPickHit {
  const mediums =
    input.mediumCount > 1 ? `${input.mediumCount} mediums · ${input.trackCount} tracks` : null;
  const tracks = input.trackCount > 0 ? `${input.trackCount} tracks` : null;
  return {
    entity: 'release',
    mbid: input.mbid,
    title: input.title,
    credit: input.artistNames.filter(Boolean).join(', ') || null,
    date: input.date,
    country: input.country,
    detail: mediums ?? tracks,
    catalogues: [],
    comment: input.comment ?? null,
    href: `https://musicbrainz.org/release/${input.mbid}`,
  };
}

export function mbWorkPickHit(input: {
  workMbid: string;
  title: string;
  type: string | null;
  composerName: string | null;
  catalogues: { system: string; number: string }[];
  comment?: string | null;
}): MbPickHit {
  return {
    entity: 'work',
    mbid: input.workMbid,
    title: input.title,
    credit: input.composerName,
    date: null,
    country: null,
    detail: input.type,
    catalogues: input.catalogues.map((catalogue) => `${catalogue.system} ${catalogue.number}`),
    comment: input.comment ?? null,
    href: `https://musicbrainz.org/work/${input.workMbid}`,
  };
}

export function mbApiReleaseToPickHit(release: {
  id: string;
  title: string;
  date: string | null;
  country: string | null;
  tracks: Array<{
    medium: number;
    recording: { artistCredit: { name: string }[] };
  }>;
}): MbPickHit {
  const first = [...release.tracks].sort((a, b) => a.medium - b.medium)[0];
  const artistNames = first?.recording.artistCredit.map((credit) => credit.name) ?? [];
  return mbReleasePickHit({
    mbid: release.id,
    title: release.title,
    date: release.date,
    country: release.country,
    artistNames,
    trackCount: release.tracks.length,
    mediumCount: new Set(release.tracks.map((track) => track.medium)).size,
  });
}
