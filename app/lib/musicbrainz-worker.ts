import { loadMusicBrainzLibraryFacts } from '@/app/actions/library-musicbrainz';
import { anchorTracksByIsrc, ingestAlbum } from './musicbrainz-ingest';
import { hydrateProviderAlbum } from './provider-hydration';
import { getSpotifyAlbumTracks } from './spotify-app-client';
import type { MusicBrainzSource } from './musicbrainz-source';
import type { TrackClassificationState } from './musicbrainz-library-facts';

/**
 * An album pass that asks MusicBrainz, not a language model.
 *
 * The order is the whole design. Write down what Spotify said; identify the
 * release; anchor each track to a recording; read the works and artists
 * those recordings reach. Only then is there anything to classify, and the
 * classification is read off MusicBrainz's own evidence rather than
 * guessed at from a track title.
 *
 * No language model is called. The previous pass used one to invent a
 * composer, a work and a movement for every track, wrote them to the
 * canonical tables, and left no way to tell an asserted value from a known
 * one. Where MusicBrainz cannot settle something now, the track keeps a
 * stated reason and stays visible — which is a worse-looking library and a
 * truer one.
 */

export type TrackPassOutcome = {
  spotifyTrackId: string;
  /** What the reader will be able to do with this track. */
  state: 'ready' | 'unanchored' | 'unclassified' | 'not_classical';
  classification: TrackClassificationState;
  /** Why, in words an editor can act on. */
  reason: string;
};

export type AlbumPassReport = {
  albumId: string;
  providerTracks: number;
  releaseMbid: string | null;
  /** Why no release, when there is none. */
  releaseReason: string | null;
  anchored: number;
  requests: number;
  tracks: TrackPassOutcome[];
};

/**
 * Run one album through the MusicBrainz stages.
 *
 * `trackIds` narrows the report to the tracks a caller cares about; every
 * track on the album is hydrated and anchored either way, because the
 * release is identified from the whole tracklist and a half-read album
 * would identify it worse.
 */
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
  // Every track asked about is already anchored, so there is nothing for
  // MusicBrainz or Spotify to tell us that we have not already written down.
  // Classifying is a local read.
  if (options.alreadyAnchored && trackIds) {
    return classifyOnly(albumId, trackIds);
  }
  const { album, tracks } = await (options.readAlbum ?? getSpotifyAlbumTracks)(albumId);
  const provider = await hydrateProviderAlbum(album, tracks);

  const ingest = await ingestAlbum(source, albumId, { fetchWorks: true });
  let requests = ingest.requests;
  let anchored = ingest.anchors?.anchored ?? 0;

  // A release we could not identify does not put the album out of reach: an
  // ISRC names a recording without one. This is the difference between an
  // album MusicBrainz has not catalogued and an album nobody can play.
  if (!ingest.releaseMbid || (ingest.anchors?.unanchored ?? 0) > 0) {
    const byIsrc = await anchorTracksByIsrc(source, { albumId });
    requests += byIsrc.requests;
    anchored += byIsrc.anchored;
  }

  const wanted = trackIds ?? tracks.map((track) => track.id);
  const facts = await loadMusicBrainzLibraryFacts(wanted);
  const anchorByTrack = new Map(facts.anchors.map((anchor) => [anchor.spotifyTrackId, anchor]));
  const classificationByTrack = new Map(
    facts.classifications.map((classification) => [classification.spotifyTrackId, classification]),
  );

  return {
    albumId,
    providerTracks: provider.tracks,
    releaseMbid: ingest.releaseMbid,
    releaseReason: ingest.releaseMbid ? null : describeReleaseFailure(ingest.reason),
    anchored,
    requests,
    tracks: wanted.map((spotifyTrackId): TrackPassOutcome => {
      const classification = classificationByTrack.get(spotifyTrackId);
      const anchor = anchorByTrack.get(spotifyTrackId);
      const reason = classification?.reason ?? 'no MusicBrainz evidence yet';
      if (classification?.state === 'not_classical') {
        return { spotifyTrackId, state: 'not_classical', classification: 'not_classical', reason };
      }
      if (!anchor || anchor.state !== 'accepted') {
        return {
          spotifyTrackId,
          state: 'unanchored',
          classification: classification?.state ?? 'unreviewed',
          reason:
            anchor?.state === 'conflicting'
              ? anchor.reason
              : (describeReleaseFailure(ingest.reason) ??
                'no MusicBrainz recording matched this track'),
        };
      }
      if (classification?.state !== 'classical') {
        return {
          spotifyTrackId,
          state: 'unclassified',
          classification: classification?.state ?? 'unreviewed',
          reason,
        };
      }
      return { spotifyTrackId, state: 'ready', classification: 'classical', reason };
    }),
  };
}

async function classifyOnly(albumId: string, trackIds: string[]): Promise<AlbumPassReport> {
  const facts = await loadMusicBrainzLibraryFacts(trackIds);
  const classificationByTrack = new Map(
    facts.classifications.map((classification) => [classification.spotifyTrackId, classification]),
  );
  return {
    albumId,
    providerTracks: 0,
    releaseMbid: null,
    releaseReason: null,
    anchored: trackIds.length,
    requests: 0,
    tracks: trackIds.map((spotifyTrackId): TrackPassOutcome => {
      const classification = classificationByTrack.get(spotifyTrackId);
      const reason = classification?.reason ?? 'no MusicBrainz evidence yet';
      if (classification?.state === 'not_classical') {
        return { spotifyTrackId, state: 'not_classical', classification: 'not_classical', reason };
      }
      if (classification?.state !== 'classical') {
        return {
          spotifyTrackId,
          state: 'unclassified',
          classification: classification?.state ?? 'unreviewed',
          reason,
        };
      }
      return { spotifyTrackId, state: 'ready', classification: 'classical', reason };
    }),
  };
}

/** The release failures, said in a way an editor can act on. */
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
