import { anchorTracksByIsrc, ingestAlbum } from './musicbrainz-ingest';
import { readTrackAnchors } from './musicbrainz-library-read';
import { classifyTracks } from './musicbrainz-track-classification';
import { hydrateProviderAlbum } from './provider-hydration';
import { getSpotifyAlbumTracks } from './spotify-app-client';
import type { MusicBrainzSource } from './musicbrainz-source';
import type { TrackClassificationState } from './musicbrainz-library-facts';
import type { PipelineOutcome, TrackClassificationProvenance } from './track-classification';

// Classification is read off MusicBrainz's evidence, not guessed from a title; no language model is
// called.

export type TrackPassOutcome = {
  spotifyTrackId: string;
  state: PipelineOutcome;
  classification: TrackClassificationState;
  classificationProvenance: TrackClassificationProvenance;
  reason: string;
};

export type AlbumPassReport = {
  albumId: string;
  providerTracks: number;
  releaseMbid: string | null;
  releaseReason: string | null;
  anchored: number;
  requests: number;
  tracks: TrackPassOutcome[];
};

// Every track on the album is anchored even when `trackIds` narrows the report: the release is
// identified from the whole tracklist.
export async function runMusicBrainzAlbumPass(
  source: MusicBrainzSource,
  albumId: string,
  trackIds?: string[],
  options: {
    alreadyAnchored?: boolean;
    /** Injectable so a test can hand the pass an album without a network. */
    readAlbum?: typeof getSpotifyAlbumTracks;
  } = {},
): Promise<AlbumPassReport> {
  // Every track asked about is already anchored, so classifying is a local read.
  if (options.alreadyAnchored && trackIds) {
    return classifyOnly(albumId, trackIds);
  }
  const { album, tracks } = await (options.readAlbum ?? getSpotifyAlbumTracks)(albumId);
  const provider = await hydrateProviderAlbum(album, tracks);

  const ingest = await ingestAlbum(source, albumId, { fetchWorks: true });
  let requests = ingest.requests;
  let anchored = ingest.anchors?.anchored ?? 0;

  // An unidentified release does not put the album out of reach: an ISRC names a recording without
  // one.
  if (!ingest.releaseMbid || (ingest.anchors?.unanchored ?? 0) > 0) {
    const byIsrc = await anchorTracksByIsrc(source, { albumId });
    requests += byIsrc.requests;
    anchored += byIsrc.anchored;
  }

  const wanted = trackIds ?? tracks.map((track) => track.id);
  // Weighs current MusicBrainz evidence, not a stored verdict: an old parser proposal must not hide
  // stronger new evidence.
  const [anchors, classifications] = await Promise.all([
    readTrackAnchors(wanted),
    classifyTracks(wanted, { preferStored: false }),
  ]);
  const anchorByTrack = new Map(anchors.map((anchor) => [anchor.spotifyTrackId, anchor]));
  const classificationByTrack = new Map(
    classifications.map((classification) => [classification.spotifyTrackId, classification]),
  );

  return {
    albumId,
    providerTracks: provider.tracks,
    releaseMbid: ingest.releaseMbid,
    releaseReason: ingest.releaseMbid ? null : describeReleaseFailure(ingest.reason),
    anchored,
    requests,
    tracks: wanted.map((spotifyTrackId) => {
      const anchor = anchorByTrack.get(spotifyTrackId);
      const unanchored =
        anchor?.state === 'accepted'
          ? null
          : anchor?.state === 'conflicting'
            ? anchor.reason
            : (describeReleaseFailure(ingest.reason) ??
              'no MusicBrainz recording matched this track');
      return trackOutcome(spotifyTrackId, classificationByTrack.get(spotifyTrackId), unanchored);
    }),
  };
}

async function classifyOnly(albumId: string, trackIds: string[]): Promise<AlbumPassReport> {
  const classifications = await classifyTracks(trackIds, { preferStored: false });
  const classificationByTrack = new Map(
    classifications.map((classification) => [classification.spotifyTrackId, classification]),
  );
  return {
    albumId,
    providerTracks: 0,
    releaseMbid: null,
    releaseReason: null,
    anchored: trackIds.length,
    requests: 0,
    tracks: trackIds.map((spotifyTrackId) =>
      trackOutcome(spotifyTrackId, classificationByTrack.get(spotifyTrackId), null),
    ),
  };
}

// A track MusicBrainz calls not classical says so whether or not it is anchored; otherwise an
// `unanchored` reason wins.
function trackOutcome(
  spotifyTrackId: string,
  classification: Awaited<ReturnType<typeof classifyTracks>>[number] | undefined,
  unanchored: string | null,
): TrackPassOutcome {
  const state: PipelineOutcome =
    classification?.state === 'not_classical'
      ? 'not_classical'
      : unanchored !== null
        ? 'unanchored'
        : classification?.state === 'classical'
          ? 'ready'
          : 'unclassified';
  return {
    spotifyTrackId,
    state,
    classification: classification?.state ?? 'unreviewed',
    classificationProvenance: classification?.provenance ?? 'musicbrainz',
    reason:
      state === 'unanchored' && unanchored !== null
        ? unanchored
        : (classification?.reason ?? 'no MusicBrainz evidence yet'),
  };
}

export function describeReleaseFailure(reason: string | null): string | null {
  switch (reason) {
    case 'no_barcode_match':
      return 'no MusicBrainz release carries this album’s barcode';
    case 'not_found':
      return 'MusicBrainz has no release we could identify this album as';
    case 'ambiguous':
      return 'several MusicBrainz releases fit this album and none is clearly it';
    default:
      return reason;
  }
}
