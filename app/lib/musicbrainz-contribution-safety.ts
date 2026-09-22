import { titlesAreCompatible } from './metadata-matching';

/**
 * Whole-release evidence required before offering an ISRC contribution.
 *
 * Spotify's disc/track numbers are not evidence of where a recording sits on
 * a MusicBrainz release. Releases can be ordered differently (Waning Moon is
 * a real example), so the only safe bridge is the recording anchor we already
 * established. Durations corroborate that identity; they never create it.
 */

export const ISRC_SUBMISSION_TOLERANCE_MS = 3_000;
export const BARCODE_SUBMISSION_TOLERANCE_MS = 5_000;

export type SpotifyReleaseEvidence = {
  albumId: string;
  releaseMbid: string;
  upc: string | null;
  spotifyTrackId: string;
  recordingMbid: string | null;
  durationMs: number;
};

export type MusicBrainzReleaseEvidence = {
  releaseMbid: string;
  barcode: string | null;
  medium: number;
  position: number;
  recordingMbid: string;
  durationMs: number | null;
};

export type SpotifyBarcodeEvidence = {
  albumTitle: string;
  discNumber: number;
  trackNumber: number;
  durationMs: number;
};

export type MusicBrainzBarcodeEvidence = {
  releaseTitle: string;
  medium: number;
  position: number;
  durationMs: number | null;
};

export type BarcodeVerification = {
  trackCount: number;
  maxDurationDeltaMs: number;
};

export function releaseMediumKey(albumId: string, releaseMbid: string, medium: number): string {
  return `${albumId}\u0000${releaseMbid}\u0000${medium}`;
}

function normaliseBarcode(value: string | null): string | null {
  const barcode = value?.trim().replace(/^0+/, '');
  return barcode ? barcode : null;
}

/**
 * The evidence required to add a barcode to a release that currently has
 * none: compatible titles, identical complete tracklists, and every duration
 * within five seconds. Missing durations fail rather than being guessed.
 */
export function verifyBarcodeRelease(
  spotifyRows: SpotifyBarcodeEvidence[],
  musicbrainzRows: MusicBrainzBarcodeEvidence[],
): BarcodeVerification | null {
  if (
    spotifyRows.length === 0 ||
    spotifyRows.length !== musicbrainzRows.length ||
    !titlesAreCompatible(spotifyRows[0].albumTitle, musicbrainzRows[0].releaseTitle)
  ) {
    return null;
  }

  const spotify = [...spotifyRows].sort(
    (a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber,
  );
  const musicbrainz = [...musicbrainzRows].sort(
    (a, b) => a.medium - b.medium || a.position - b.position,
  );
  let maxDurationDeltaMs = 0;
  for (let index = 0; index < spotify.length; index++) {
    const duration = musicbrainz[index].durationMs;
    if (duration === null) return null;
    const delta = Math.abs(duration - spotify[index].durationMs);
    if (delta > BARCODE_SUBMISSION_TOLERANCE_MS) return null;
    maxDurationDeltaMs = Math.max(maxDurationDeltaMs, delta);
  }
  return { trackCount: spotify.length, maxDurationDeltaMs };
}

/**
 * Whether two complete tracklists have a one-to-one, evidence-backed mapping.
 *
 * Matching is by anchored recording identity first and duration second. This
 * deliberately ignores position, allowing a known out-of-order release while
 * refusing a duration-only zip that could attach every ISRC to the wrong
 * recording. The augmenting-path match also handles a recording repeated on a
 * release without allowing two Spotify tracks to reuse one MusicBrainz slot.
 */
function hasPerfectRecordingMapping(
  spotify: SpotifyReleaseEvidence[],
  musicbrainz: MusicBrainzReleaseEvidence[],
): boolean {
  if (spotify.length === 0 || spotify.length !== musicbrainz.length) return false;

  const claimedBy = new Array<number>(musicbrainz.length).fill(-1);

  function claim(spotifyIndex: number, seen: Set<number>): boolean {
    const track = spotify[spotifyIndex];
    if (!track.recordingMbid) return false;

    for (let mbIndex = 0; mbIndex < musicbrainz.length; mbIndex++) {
      const releaseTrack = musicbrainz[mbIndex];
      if (
        seen.has(mbIndex) ||
        releaseTrack.recordingMbid !== track.recordingMbid ||
        releaseTrack.durationMs === null ||
        Math.abs(releaseTrack.durationMs - track.durationMs) > ISRC_SUBMISSION_TOLERANCE_MS
      ) {
        continue;
      }

      seen.add(mbIndex);
      if (claimedBy[mbIndex] === -1 || claim(claimedBy[mbIndex], seen)) {
        claimedBy[mbIndex] = spotifyIndex;
        return true;
      }
    }
    return false;
  }

  return spotify.every((_, index) => claim(index, new Set()));
}

/**
 * Album/release/media combinations that satisfy the complete ISRC standard:
 * the same barcode, identical track count, and every anchored recording's
 * duration within three seconds.
 */
export function verifiedIsrcReleaseMedia(
  spotifyRows: SpotifyReleaseEvidence[],
  musicbrainzRows: MusicBrainzReleaseEvidence[],
): Set<string> {
  const spotifyByRelease = new Map<string, SpotifyReleaseEvidence[]>();
  for (const row of spotifyRows) {
    const key = `${row.albumId}\u0000${row.releaseMbid}`;
    const rows = spotifyByRelease.get(key) ?? [];
    rows.push(row);
    spotifyByRelease.set(key, rows);
  }

  const musicbrainzByRelease = new Map<string, MusicBrainzReleaseEvidence[]>();
  for (const row of musicbrainzRows) {
    const rows = musicbrainzByRelease.get(row.releaseMbid) ?? [];
    rows.push(row);
    musicbrainzByRelease.set(row.releaseMbid, rows);
  }

  const verified = new Set<string>();
  for (const spotify of spotifyByRelease.values()) {
    const first = spotify[0];
    const barcode = normaliseBarcode(first.upc);
    if (!barcode || spotify.some((row) => normaliseBarcode(row.upc) !== barcode)) continue;

    const musicbrainz = musicbrainzByRelease.get(first.releaseMbid);
    if (
      !musicbrainz ||
      normaliseBarcode(musicbrainz[0].barcode) !== barcode ||
      musicbrainz.some((row) => normaliseBarcode(row.barcode) !== barcode)
    ) {
      continue;
    }

    const byMedium = new Map<number, MusicBrainzReleaseEvidence[]>();
    for (const row of musicbrainz) {
      const rows = byMedium.get(row.medium) ?? [];
      rows.push(row);
      byMedium.set(row.medium, rows);
    }

    /*
     * Normal multi-disc releases are one tracklist spread over all media.
     * Hybrid SACDs repeat the complete tracklist on every layer, so their
     * total is a multiple of Spotify's count; accept that shape only when
     * every medium independently proves the same complete one-to-one map.
     */
    const wholeReleaseMatches = hasPerfectRecordingMapping(spotify, musicbrainz);
    const repeatedCompleteLayers =
      byMedium.size > 1 &&
      [...byMedium.values()].every((medium) => hasPerfectRecordingMapping(spotify, medium));
    if (!wholeReleaseMatches && !repeatedCompleteLayers) continue;

    for (const medium of byMedium.keys()) {
      verified.add(releaseMediumKey(first.albumId, first.releaseMbid, medium));
    }
  }
  return verified;
}
