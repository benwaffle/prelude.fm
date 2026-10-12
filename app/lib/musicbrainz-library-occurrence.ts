import type {
  MbReleaseFact,
  MbReleaseTrackFact,
  ProviderAlbumFact,
  ProviderTrackFact,
} from './musicbrainz-library-facts';
import { gap, nonBlank, pushGap, type MusicBrainzGap } from './musicbrainz-library-gaps';

export type ProjectedProviderOccurrence = {
  spotifyTrackId: string;
  providerTitle: string;
  spotifyAlbumId: string;
  /** Null when the provider album has not been fetched; never a blank stand-in. */
  providerAlbumTitle: string | null;
  imageUrl: string | null;
  discNumber: number;
  trackNumber: number;
  durationMs: number;
  popularity: number | null;
  popularityState: 'ranked' | 'unranked';
  held: boolean;
  albumAnchoredTrackCount: number;
  releaseMbid: string | null;
  releaseTitle: string | null;
  releaseDate: string | null;
  releaseTrackTitle: string | null;
  gaps: MusicBrainzGap[];
};

export type OccurrenceIndex = {
  albumById: Map<string, ProviderAlbumFact>;
  releaseById: Map<string, MbReleaseFact>;
  releaseTrackByPosition: Map<string, MbReleaseTrackFact>;
  acceptedAnchorCountByAlbum: Map<string, number>;
};

export function releaseGaps(
  track: ProviderTrackFact,
  index: OccurrenceIndex,
  expectedRecordingMbid: string | null,
): MusicBrainzGap[] {
  const { albumById, releaseById, releaseTrackByPosition } = index;
  const gaps: MusicBrainzGap[] = [];
  const album = albumById.get(track.spotifyAlbumId);
  if (!album) {
    pushGap(gaps, gap('provider-album-not-fetched', 'album', track.spotifyAlbumId));
    return gaps;
  }

  const resolution = album.releaseResolution;
  if (resolution.state === 'not_checked') {
    pushGap(gaps, gap('release-not-checked', 'album', album.spotifyAlbumId));
    return gaps;
  }
  if (resolution.state === 'missing') {
    pushGap(gaps, gap('release-missing', 'album', album.spotifyAlbumId));
    return gaps;
  }
  if (resolution.state === 'ambiguous') {
    pushGap(
      gaps,
      gap('release-ambiguous', 'album', album.spotifyAlbumId, resolution.candidateMbids.join(', ')),
    );
    return gaps;
  }
  if (resolution.state === 'misaligned') {
    pushGap(
      gaps,
      gap('release-tracklist-misaligned', 'release', resolution.releaseMbid, resolution.reason),
    );
    return gaps;
  }

  const release = releaseById.get(resolution.releaseMbid);
  if (!release) {
    pushGap(gaps, gap('release-cache-missing', 'release', resolution.releaseMbid));
    return gaps;
  }
  if (!nonBlank(release.title)) {
    pushGap(gaps, gap('release-title-missing', 'release', release.mbid));
  }
  if (!nonBlank(release.date)) {
    pushGap(gaps, gap('release-date-missing', 'release', release.mbid));
  }
  if (release.spotifyFreeStreamingUrlState === 'missing') {
    pushGap(gaps, gap('release-spotify-streaming-url-missing', 'release', release.mbid));
  }

  if (expectedRecordingMbid) {
    const releaseTrack = releaseTrackByPosition.get(
      `${release.mbid}:${track.discNumber}:${track.trackNumber}`,
    );
    if (!releaseTrack || releaseTrack.recordingMbid !== expectedRecordingMbid) {
      pushGap(
        gaps,
        gap(
          'release-track-position-mismatch',
          'track',
          track.spotifyTrackId,
          releaseTrack
            ? `position names ${releaseTrack.recordingMbid}, anchor names ${expectedRecordingMbid}`
            : `no MusicBrainz track at medium ${track.discNumber}, position ${track.trackNumber}`,
        ),
      );
    }
  }

  return gaps;
}

export function projectOccurrence(
  track: ProviderTrackFact,
  heldTrackIds: Set<string>,
  index: OccurrenceIndex,
  recordingMbid: string | null,
): ProjectedProviderOccurrence {
  const { albumById, releaseById, acceptedAnchorCountByAlbum } = index;
  const album = albumById.get(track.spotifyAlbumId);
  const gaps = releaseGaps(track, index, recordingMbid);
  const releaseMbid =
    album?.releaseResolution.state === 'matched'
      ? album.releaseResolution.releaseMbid
      : album?.releaseResolution.state === 'misaligned'
        ? album.releaseResolution.releaseMbid
        : null;
  const release = releaseMbid ? releaseById.get(releaseMbid) : undefined;
  const releaseTrack = releaseMbid
    ? index.releaseTrackByPosition.get(`${releaseMbid}:${track.discNumber}:${track.trackNumber}`)
    : undefined;

  return {
    spotifyTrackId: track.spotifyTrackId,
    providerTitle: track.title,
    spotifyAlbumId: track.spotifyAlbumId,
    providerAlbumTitle: album ? nonBlank(album.title) : null,
    imageUrl: album?.imageUrl ?? null,
    discNumber: track.discNumber,
    trackNumber: track.trackNumber,
    durationMs: track.durationMs,
    popularity: track.popularity,
    popularityState: track.popularity === null ? 'unranked' : 'ranked',
    held: heldTrackIds.has(track.spotifyTrackId),
    albumAnchoredTrackCount: acceptedAnchorCountByAlbum.get(track.spotifyAlbumId) ?? 0,
    releaseMbid,
    releaseTitle: release ? nonBlank(release.title) : null,
    releaseDate: release ? nonBlank(release.date) : null,
    releaseTrackTitle: releaseTrack ? nonBlank(releaseTrack.title) : null,
    gaps,
  };
}

export function compareOccurrences(
  left: ProjectedProviderOccurrence,
  right: ProjectedProviderOccurrence,
): number {
  if (left.held !== right.held) return left.held ? -1 : 1;
  const fullness = right.albumAnchoredTrackCount - left.albumAnchoredTrackCount;
  if (fullness !== 0) return fullness;
  const popularity = compareNullableNumberDescending(left.popularity, right.popularity);
  if (popularity !== 0) return popularity;
  return left.spotifyTrackId.localeCompare(right.spotifyTrackId);
}

function compareNullableNumberDescending(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}
