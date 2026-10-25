import { eq, inArray } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './db';
import { forChunks } from './db/chunked';
import { heldWorkLinks } from './db/held-work-links';
import {
  mbArtist,
  mbRecording,
  mbRecordingCredit,
  mbRecordingIsrc,
  mbRelease,
  mbReleaseTrack,
  mbReleaseUrl,
  spotifyAlbum,
  spotifyArtist,
  spotifyTrack,
  trackRecording,
} from './db/schema';
import { readWorkCatalogue, readWorkNeighbourhood } from './db/work-tree-sql';
import type {
  MbArtistFact,
  MbRecordingCreditFact,
  MbRecordingFact,
  MbRecordingWorkFact,
  MbReleaseFact,
  MbReleaseTrackFact,
  MbWorkCatalogueFact,
  MbWorkFact,
  MusicBrainzLibraryFacts,
  OwnWorkLinkFact,
  ProviderAlbumFact,
  ProviderTrackFact,
  ReleaseResolution,
  TrackAnchorFact,
} from './musicbrainz-library-facts';
import { catalogedComposerMbids, classifyTracks } from './musicbrainz-track-classification';
import { portraitOf } from './prelude';

// Reads only provider tables, `track_recording` and `mb_*`: the projection can't show what this
// doesn't fetch, which is how the authority boundary is enforced.

const FREE_STREAMING_RELATIONSHIP_TYPE_ID = '08445ccf-7b99-4438-9f9a-fb9ac18099ee';

function isSpotifyFreeStreamingRelation(relation: {
  url: string;
  relationshipTypeId: string;
  ended: boolean;
}): boolean {
  if (relation.ended || relation.relationshipTypeId !== FREE_STREAMING_RELATIONSHIP_TYPE_ID) {
    return false;
  }
  try {
    return new URL(relation.url).hostname.toLowerCase() === 'open.spotify.com';
  } catch {
    return false;
  }
}

function releaseResolutionOf(album: {
  mbReleaseId: string | null;
  mbReleaseCandidates: number | null;
  mbCheckedAt: Date | null;
}): ReleaseResolution {
  if (album.mbReleaseId) return { state: 'matched', releaseMbid: album.mbReleaseId };
  if (!album.mbCheckedAt) return { state: 'not_checked' };
  // We know how many releases carry the barcode but not which; say "several" rather than inventing
  // MBIDs.
  if ((album.mbReleaseCandidates ?? 0) > 1) return { state: 'ambiguous', candidateMbids: [] };
  return { state: 'missing' };
}

export async function loadMusicBrainzLibraryFacts(
  spotifyTrackIds: string[],
  database: DatabaseExecutor = db,
): Promise<MusicBrainzLibraryFacts> {
  const requestedTrackIds = Array.from(new Set(spotifyTrackIds));
  if (requestedTrackIds.length === 0) return emptyFacts([]);

  // Asked now and awaited last: it reads on its own and nothing below needs it.
  const classifications = classifyTracks(requestedTrackIds, { preferStored: true }, database);
  // Settled here so a failure elsewhere cannot leave it as an unhandled rejection.
  classifications.catch(() => {});

  // Every provider track anchored to these recordings, so the projection can coalesce one
  // performance issued on several albums.
  const requested = new Set(requestedTrackIds);
  const [anchorRows, links] = await Promise.all([
    forChunks(requestedTrackIds, (chunk) =>
      database
        .select()
        .from(trackRecording)
        .where(
          inArray(
            trackRecording.recordingMbid,
            database
              .select({ recordingMbid: trackRecording.recordingMbid })
              .from(trackRecording)
              .where(inArray(trackRecording.spotifyTrackId, chunk)),
          ),
        ),
    ),
    heldWorkLinks({ tracks: requestedTrackIds }, database),
  ]);
  const requestedAnchors = anchorRows.filter((anchor) => requested.has(anchor.spotifyTrackId));
  const recordingMbids = new Set(requestedAnchors.map((anchor) => anchor.recordingMbid));
  const anchorByTrackId = new Map(
    [...requestedAnchors, ...anchorRows].map((anchor) => [anchor.spotifyTrackId, anchor]),
  );

  // The precedence is `heldWorkLinks`'s.
  const recordingWorks = new Map<string, MbRecordingWorkFact>();
  const ownWorkLinks = new Map<string, OwnWorkLinkFact>();
  for (const link of links) {
    if (link.linkedBy === 'musicbrainz') {
      recordingWorks.set(`${link.recordingMbid} ${link.workMbid}`, {
        recordingMbid: link.recordingMbid!,
        workMbid: link.workMbid,
      });
    } else if (link.recordingMbid === null) {
      ownWorkLinks.set(`track:${link.spotifyTrackId}`, {
        subject: 'track',
        spotifyTrackId: link.spotifyTrackId,
        workMbid: link.workMbid,
        confidence: link.confidence ?? 'high',
      });
    } else {
      ownWorkLinks.set(link.recordingMbid, {
        subject: 'recording',
        recordingMbid: link.recordingMbid,
        workMbid: link.workMbid,
        confidence: link.confidence ?? 'high',
      });
    }
  }

  // Tracks and their albums in one round trip.
  const providerTrackIds = new Set([...requestedTrackIds, ...anchorByTrackId.keys()]);
  const [providerTrackRows, albumRows, recordingRows, creditRows, workRows] = await Promise.all([
    forChunks(providerTrackIds, (chunk) =>
      database.select().from(spotifyTrack).where(inArray(spotifyTrack.spotifyId, chunk)),
    ),
    forChunks(providerTrackIds, (chunk) =>
      database
        .select()
        .from(spotifyAlbum)
        .where(
          inArray(
            spotifyAlbum.spotifyId,
            database
              .select({ spotifyAlbumId: spotifyTrack.spotifyAlbumId })
              .from(spotifyTrack)
              .where(inArray(spotifyTrack.spotifyId, chunk)),
          ),
        ),
    ),
    forChunks(recordingMbids, (chunk) =>
      database.select().from(mbRecording).where(inArray(mbRecording.mbid, chunk)),
    ),
    forChunks(recordingMbids, (chunk) =>
      database
        .select()
        .from(mbRecordingCredit)
        .where(inArray(mbRecordingCredit.recordingMbid, chunk)),
    ),
    readWorkNeighbourhood(
      [...links].map((link) => link.workMbid),
      database,
      { wholeTrees: true },
    ),
  ]);
  const providerAlbumRows = Array.from(
    new Map(albumRows.map((album) => [album.spotifyId, album])).values(),
  );
  const releaseMbids = providerAlbumRows
    .map((album) => album.mbReleaseId)
    .filter((mbid): mbid is string => mbid !== null);
  const composerMbids = workRows
    .map((work) => work.composerMbid)
    .filter((mbid): mbid is string => !!mbid);

  // Only for tracks we could not anchor: an ISRC naming two recordings is a contradiction worth
  // showing.
  const unanchoredIsrcs = providerTrackRows.flatMap((track) =>
    !anchorByTrackId.has(track.spotifyId) && track.isrc ? [track.isrc] : [],
  );

  const [
    releaseRows,
    releaseTrackRows,
    releaseUrlRows,
    catalogueRows,
    artistRows,
    catalogedComposers,
    isrcRecordings,
  ] = await Promise.all([
    forChunks(releaseMbids, (chunk) =>
      database.select().from(mbRelease).where(inArray(mbRelease.mbid, chunk)),
    ),
    forChunks(releaseMbids, (chunk) =>
      database.select().from(mbReleaseTrack).where(inArray(mbReleaseTrack.releaseMbid, chunk)),
    ),
    forChunks(releaseMbids, (chunk) =>
      database.select().from(mbReleaseUrl).where(inArray(mbReleaseUrl.releaseMbid, chunk)),
    ),
    readWorkCatalogue(
      workRows.map((work) => work.mbid),
      database,
    ),
    forChunks([...composerMbids, ...creditRows.map((credit) => credit.artistMbid)], (chunk) =>
      database
        .select({ artist: mbArtist, images: spotifyArtist.images })
        .from(mbArtist)
        .leftJoin(spotifyArtist, eq(spotifyArtist.spotifyId, mbArtist.spotifyArtistId))
        .where(inArray(mbArtist.mbid, chunk)),
    ),
    catalogedComposerMbids(composerMbids, database),
    readIsrcRecordings(unanchoredIsrcs, database),
  ]);
  // Tracks and URLs of a release the cache does not hold describe nothing.
  const cachedReleases = new Set(releaseRows.map((release) => release.mbid));
  const releasesWithSpotifyFreeStreaming = new Set(
    releaseUrlRows
      .filter((relation) => cachedReleases.has(relation.releaseMbid))
      .filter(isSpotifyFreeStreamingRelation)
      .map((relation) => relation.releaseMbid),
  );

  const anchors = providerTrackRows.flatMap((track) =>
    anchorFactOf(track, anchorByTrackId.get(track.spotifyId), isrcRecordings),
  );

  return {
    requestedTrackIds,
    classifications: await classifications,
    providerAlbums: providerAlbumRows.map(
      (album): ProviderAlbumFact => ({
        spotifyAlbumId: album.spotifyId,
        title: album.title,
        imageUrl: album.images?.[0]?.url ?? null,
        popularity: album.popularity,
        releaseResolution: releaseResolutionOf(album),
      }),
    ),
    providerTracks: providerTrackRows.map(
      (track): ProviderTrackFact => ({
        spotifyTrackId: track.spotifyId,
        title: track.title,
        spotifyAlbumId: track.spotifyAlbumId,
        discNumber: track.discNumber,
        trackNumber: track.trackNumber,
        durationMs: track.durationMs,
        popularity: track.popularity,
      }),
    ),
    anchors,
    mbRecordings: recordingRows.map(
      (recording): MbRecordingFact => ({
        mbid: recording.mbid,
        title: recording.title,
        lengthMs: recording.length,
        detail: recording.detail,
      }),
    ),
    mbRecordingWorks: [...recordingWorks.values()],
    mbWorks: workRows.map(
      (row): MbWorkFact => ({
        mbid: row.mbid,
        title: row.title,
        type: row.type,
        parentMbid: row.parentMbid,
        orderingKey: row.orderingKey,
        composerMbid: row.composerMbid,
        detail: row.detail,
      }),
    ),
    mbWorkCatalogues: catalogueRows.map(
      (catalogue): MbWorkCatalogueFact => ({
        workMbid: catalogue.workMbid,
        seriesMbid: catalogue.seriesMbid,
        system: catalogue.system,
        number: catalogue.number,
        normalizedSystem: catalogue.normalizedSystem,
        normalizedNumber: catalogue.normalizedNumber,
      }),
    ),
    mbArtists: artistRows.map(
      ({ artist, images }): MbArtistFact => ({
        mbid: artist.mbid,
        name: artist.name,
        creditedName: artist.creditedName,
        sortName: artist.sortName,
        type: artist.type,
        beginYear: artist.beginYear,
        endYear: artist.endYear,
        portrait: portraitOf(images),
      }),
    ),
    mbRecordingCredits: creditRows.map(
      (credit): MbRecordingCreditFact => ({
        recordingMbid: credit.recordingMbid,
        artistMbid: credit.artistMbid,
        role: credit.role,
        // '' is how the table spells "no instrument": the column is part of the key and SQLite
        // allows duplicate nulls.
        instrument: credit.instrument || null,
      }),
    ),
    mbReleases: releaseRows.map(
      (release): MbReleaseFact => ({
        mbid: release.mbid,
        title: release.title,
        date: release.date,
        country: release.country,
        spotifyFreeStreamingUrlState:
          release.urlRelationsFetchedAt === null
            ? 'unknown'
            : releasesWithSpotifyFreeStreaming.has(release.mbid)
              ? 'present'
              : 'missing',
      }),
    ),
    mbReleaseTracks: releaseTrackRows
      .filter((track) => cachedReleases.has(track.releaseMbid))
      .map(
        (track): MbReleaseTrackFact => ({
          releaseMbid: track.releaseMbid,
          medium: track.medium,
          position: track.position,
          recordingMbid: track.recordingMbid,
          title: track.title,
          lengthMs: track.length,
        }),
      ),
    ownWorkLinks: [...ownWorkLinks.values()],
    mbCatalogedComposerMbids: [...catalogedComposers],
  };
}

type AnchorRow = typeof trackRecording.$inferSelect;

function anchorFactOf(
  track: { spotifyId: string; isrc: string | null },
  anchor: AnchorRow | undefined,
  isrcRecordings: Map<string, string[]>,
): TrackAnchorFact[] {
  if (anchor) {
    return [
      {
        spotifyTrackId: anchor.spotifyTrackId,
        state: 'accepted',
        recordingMbid: anchor.recordingMbid,
        matchedBy: anchor.matchedBy,
        isrc: anchor.isrc,
      },
    ];
  }
  const candidates = track.isrc ? (isrcRecordings.get(track.isrc) ?? []) : [];
  if (candidates.length < 2) return [];
  return [
    {
      spotifyTrackId: track.spotifyId,
      state: 'conflicting',
      candidateRecordingMbids: [...candidates].sort(),
      reason: `ISRC ${track.isrc} names ${candidates.length} MusicBrainz recordings`,
    },
  ];
}

async function readIsrcRecordings(
  isrcs: string[],
  database: DatabaseExecutor,
): Promise<Map<string, string[]>> {
  const rows = await forChunks(isrcs, (chunk) =>
    database.select().from(mbRecordingIsrc).where(inArray(mbRecordingIsrc.isrc, chunk)),
  );
  const byIsrc = new Map<string, string[]>();
  for (const row of rows)
    byIsrc.set(row.isrc, [...(byIsrc.get(row.isrc) ?? []), row.recordingMbid]);
  return byIsrc;
}

export async function readTrackAnchors(
  spotifyTrackIds: string[],
  database: DatabaseExecutor = db,
): Promise<TrackAnchorFact[]> {
  const ids = Array.from(new Set(spotifyTrackIds));
  if (ids.length === 0) return [];
  const [tracks, anchorRows] = await Promise.all([
    forChunks(ids, (chunk) =>
      database
        .select({ spotifyId: spotifyTrack.spotifyId, isrc: spotifyTrack.isrc })
        .from(spotifyTrack)
        .where(inArray(spotifyTrack.spotifyId, chunk)),
    ),
    forChunks(ids, (chunk) =>
      database.select().from(trackRecording).where(inArray(trackRecording.spotifyTrackId, chunk)),
    ),
  ]);
  const anchorByTrackId = new Map(anchorRows.map((anchor) => [anchor.spotifyTrackId, anchor]));
  const isrcRecordings = await readIsrcRecordings(
    tracks.flatMap((track) =>
      !anchorByTrackId.has(track.spotifyId) && track.isrc ? [track.isrc] : [],
    ),
    database,
  );
  return tracks.flatMap((track) =>
    anchorFactOf(track, anchorByTrackId.get(track.spotifyId), isrcRecordings),
  );
}

function emptyFacts(requestedTrackIds: string[]): MusicBrainzLibraryFacts {
  return {
    requestedTrackIds,
    classifications: [],
    providerAlbums: [],
    providerTracks: [],
    anchors: [],
    mbRecordings: [],
    mbRecordingWorks: [],
    mbWorks: [],
    mbWorkCatalogues: [],
    mbArtists: [],
    mbRecordingCredits: [],
    mbReleases: [],
    mbReleaseTracks: [],
    ownWorkLinks: [],
    mbCatalogedComposerMbids: [],
  };
}
