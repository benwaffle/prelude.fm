import { inArray } from 'drizzle-orm';
import { db, type DatabaseExecutor } from '@/lib/db';
import {
  mbArtist,
  mbRecording,
  mbRecordingCredit,
  mbRecordingIsrc,
  mbRecordingWork,
  mbRelease,
  mbReleaseTrack,
  mbWork,
  mbWorkCatalogue,
  matchQueue,
  spotifyAlbum,
  spotifyTrack,
  trackRecording,
} from '@/lib/db/schema';
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
  ProviderAlbumFact,
  ProviderTrackFact,
  ReleaseResolution,
  TrackAnchorFact,
  TrackClassification,
} from '@/lib/musicbrainz-library-facts';

/**
 * Reads everything the MusicBrainz reader projection needs, from the Spotify
 * provider tables, `track_recording` and `mb_*` only. No legacy `work`,
 * `work_part_v2`, `recording_v2` or parser column is touched — the projection
 * cannot show what this does not fetch, which is how the authority boundary
 * is enforced in practice rather than by convention.
 *
 * Nothing here decides anything. A field MusicBrainz does not have arrives
 * null and the projection names the gap.
 */

/** SQLite binds each list element as a parameter, and the limit is ~999. */
const PARAMETER_CHUNK = 400;

async function forChunks<Input, Row>(
  values: Iterable<Input>,
  read: (chunk: Input[]) => Promise<Row[]>,
): Promise<Row[]> {
  const unique = Array.from(new Set(values));
  const rows: Row[] = [];
  for (let start = 0; start < unique.length; start += PARAMETER_CHUNK) {
    rows.push(...(await read(unique.slice(start, start + PARAMETER_CHUNK))));
  }
  return rows;
}

/**
 * A MusicBrainz work tree is recursive and arbitrarily deep, so the ancestors
 * are walked a generation at a time until the set stops growing. The bound is
 * a guard against a cycle in the cache, which the projection also reports.
 */
const MAX_WORK_GENERATIONS = 16;

function releaseResolutionOf(album: {
  mbReleaseId: string | null;
  mbReleaseCandidates: number | null;
  mbCheckedAt: Date | null;
}): ReleaseResolution {
  if (album.mbReleaseId) return { state: 'matched', releaseMbid: album.mbReleaseId };
  if (!album.mbCheckedAt) return { state: 'not_checked' };
  // We know how many releases carry the barcode but not which they are; the
  // reader says "several" rather than inventing MBIDs it was never given.
  if ((album.mbReleaseCandidates ?? 0) > 1) return { state: 'ambiguous', candidateMbids: [] };
  return { state: 'missing' };
}

export async function loadMusicBrainzLibraryFacts(
  spotifyTrackIds: string[],
  database: DatabaseExecutor = db,
): Promise<MusicBrainzLibraryFacts> {
  const requestedTrackIds = Array.from(new Set(spotifyTrackIds));
  if (requestedTrackIds.length === 0) return emptyFacts([]);

  const requestedAnchors = await forChunks(requestedTrackIds, (chunk) =>
    database.select().from(trackRecording).where(inArray(trackRecording.spotifyTrackId, chunk)),
  );
  const recordingMbids = new Set(requestedAnchors.map((anchor) => anchor.recordingMbid));

  // The same performance can be issued on several Spotify albums. Pulling
  // every provider track anchored to these recordings is what lets the
  // projection coalesce them into one recording with several playable
  // occurrences instead of showing the holding twice.
  const siblingAnchors = await forChunks(recordingMbids, (chunk) =>
    database.select().from(trackRecording).where(inArray(trackRecording.recordingMbid, chunk)),
  );
  const anchorByTrackId = new Map(
    [...requestedAnchors, ...siblingAnchors].map((anchor) => [anchor.spotifyTrackId, anchor]),
  );

  const providerTrackIds = new Set([...requestedTrackIds, ...anchorByTrackId.keys()]);
  const providerTrackRows = await forChunks(providerTrackIds, (chunk) =>
    database.select().from(spotifyTrack).where(inArray(spotifyTrack.spotifyId, chunk)),
  );
  const providerAlbumRows = await forChunks(
    providerTrackRows.map((track) => track.spotifyAlbumId),
    (chunk) => database.select().from(spotifyAlbum).where(inArray(spotifyAlbum.spotifyId, chunk)),
  );

  const [recordingRows, recordingWorkRows, creditRows, queueRows, isrcRows, releaseRows] =
    await Promise.all([
      forChunks(recordingMbids, (chunk) =>
        database.select().from(mbRecording).where(inArray(mbRecording.mbid, chunk)),
      ),
      forChunks(recordingMbids, (chunk) =>
        database
          .select()
          .from(mbRecordingWork)
          .where(inArray(mbRecordingWork.recordingMbid, chunk)),
      ),
      forChunks(recordingMbids, (chunk) =>
        database
          .select()
          .from(mbRecordingCredit)
          .where(inArray(mbRecordingCredit.recordingMbid, chunk)),
      ),
      forChunks(requestedTrackIds, (chunk) =>
        database.select().from(matchQueue).where(inArray(matchQueue.spotifyId, chunk)),
      ),
      // Only for tracks we could not anchor: an ISRC naming two recordings is
      // the contradiction, and it is worth showing rather than dropping.
      forChunks(
        providerTrackRows
          .filter((track) => !anchorByTrackId.has(track.spotifyId) && track.isrc)
          .map((track) => track.isrc!),
        (chunk) =>
          database.select().from(mbRecordingIsrc).where(inArray(mbRecordingIsrc.isrc, chunk)),
      ),
      forChunks(
        providerAlbumRows
          .map((album) => album.mbReleaseId)
          .filter((mbid): mbid is string => mbid !== null),
        (chunk) => database.select().from(mbRelease).where(inArray(mbRelease.mbid, chunk)),
      ),
    ]);

  const releaseTrackRows = await forChunks(
    releaseRows.map((release) => release.mbid),
    (chunk) =>
      database.select().from(mbReleaseTrack).where(inArray(mbReleaseTrack.releaseMbid, chunk)),
  );

  const workRows = await readWorkTree(
    recordingWorkRows.map((relation) => relation.workMbid),
    database,
  );
  const workMbids = workRows.map((work) => work.mbid);
  const [catalogueRows, artistRows] = await Promise.all([
    forChunks(workMbids, (chunk) =>
      database.select().from(mbWorkCatalogue).where(inArray(mbWorkCatalogue.workMbid, chunk)),
    ),
    forChunks(
      [
        ...workRows.map((work) => work.composerMbid).filter((mbid): mbid is string => !!mbid),
        ...creditRows.map((credit) => credit.artistMbid),
      ],
      (chunk) => database.select().from(mbArtist).where(inArray(mbArtist.mbid, chunk)),
    ),
  ]);

  const queueStatusByTrack = new Map(queueRows.map((row) => [row.spotifyId, row.status]));
  const isrcRecordings = new Map<string, string[]>();
  for (const row of isrcRows) {
    isrcRecordings.set(row.isrc, [...(isrcRecordings.get(row.isrc) ?? []), row.recordingMbid]);
  }

  // A track whose ISRC names two recordings has no anchor, but MusicBrainz
  // still says something about it. Without asking whether those candidates
  // are of works, the track would be filed as unclassified and the
  // contradiction — the thing worth contributing a fix for — would never be
  // reported.
  const candidateWorkRows = await forChunks([...isrcRecordings.values()].flat(), (chunk) =>
    database.select().from(mbRecordingWork).where(inArray(mbRecordingWork.recordingMbid, chunk)),
  );
  const recordingHasWork = new Set(
    [...recordingWorkRows, ...candidateWorkRows].map((relation) => relation.recordingMbid),
  );

  const providerTrackById = new Map(providerTrackRows.map((track) => [track.spotifyId, track]));
  const anchors: TrackAnchorFact[] = [];
  for (const track of providerTrackRows) {
    const anchor = anchorByTrackId.get(track.spotifyId);
    if (anchor) {
      anchors.push({
        spotifyTrackId: anchor.spotifyTrackId,
        state: 'accepted',
        recordingMbid: anchor.recordingMbid,
        matchedBy: anchor.matchedBy,
        isrc: anchor.isrc,
      });
      continue;
    }
    const candidates = track.isrc ? (isrcRecordings.get(track.isrc) ?? []) : [];
    if (candidates.length > 1) {
      anchors.push({
        spotifyTrackId: track.spotifyId,
        state: 'conflicting',
        candidateRecordingMbids: [...candidates].sort(),
        reason: `ISRC ${track.isrc} names ${candidates.length} MusicBrainz recordings`,
      });
    }
  }

  return {
    requestedTrackIds,
    classifications: requestedTrackIds.flatMap((spotifyTrackId) => {
      const track = providerTrackById.get(spotifyTrackId);
      const evidenceMbids = anchorByTrackId.has(spotifyTrackId)
        ? [anchorByTrackId.get(spotifyTrackId)!.recordingMbid]
        : (track?.isrc && isrcRecordings.get(track.isrc)) || [];
      const classification = classify(
        spotifyTrackId,
        evidenceMbids,
        recordingHasWork,
        queueStatusByTrack.get(spotifyTrackId) ?? null,
      );
      return classification ? [classification] : [];
    }),
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
    mbRecordingWorks: recordingWorkRows.map(
      (relation): MbRecordingWorkFact => ({
        recordingMbid: relation.recordingMbid,
        workMbid: relation.workMbid,
      }),
    ),
    mbWorks: workRows,
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
      (artist): MbArtistFact => ({
        mbid: artist.mbid,
        name: artist.name,
        creditedName: artist.creditedName,
        sortName: artist.sortName,
        type: artist.type,
        beginYear: artist.beginYear,
        endYear: artist.endYear,
      }),
    ),
    mbRecordingCredits: creditRows.map(
      (credit): MbRecordingCreditFact => ({
        recordingMbid: credit.recordingMbid,
        artistMbid: credit.artistMbid,
        role: credit.role,
        // '' is how the table spells "this role has no instrument", because
        // the column is part of the key and SQLite would allow duplicate nulls.
        instrument: credit.instrument || null,
      }),
    ),
    mbReleases: releaseRows.map(
      (release): MbReleaseFact => ({
        mbid: release.mbid,
        title: release.title,
        date: release.date,
        country: release.country,
      }),
    ),
    mbReleaseTracks: releaseTrackRows.map(
      (track): MbReleaseTrackFact => ({
        releaseMbid: track.releaseMbid,
        medium: track.medium,
        position: track.position,
        recordingMbid: track.recordingMbid,
        title: track.title,
        lengthMs: track.length,
      }),
    ),
  };
}

/**
 * There is no classification store yet, so this states what the existing rows
 * actually support and nothing more. MusicBrainz relating the anchored
 * recording to a work is deterministic evidence and outranks the parser;
 * `match_queue`'s `not_classical` is an LLM verdict and is labelled as the
 * proposal it is; anything else is unreviewed, with the reason saying so
 * rather than a guess standing in for a decision nobody has made.
 */
function classify(
  spotifyTrackId: string,
  evidenceMbids: string[],
  recordingHasWork: Set<string>,
  queueStatus: string | null,
): TrackClassification | null {
  // Every recording this track could be — one when it is anchored, several
  // when its ISRC is contested. All of them being of a work is what makes
  // "classical" a MusicBrainz statement rather than a coin toss; which
  // recording it is stays an open question the anchor reports.
  const named = evidenceMbids.filter((mbid) => recordingHasWork.has(mbid));
  if (evidenceMbids.length > 0 && named.length === evidenceMbids.length) {
    return {
      spotifyTrackId,
      state: 'classical',
      provenance: 'musicbrainz',
      reason:
        queueStatus === 'not_classical'
          ? `MusicBrainz relates ${named.join(', ')} to a work, but the parser ruled this not classical`
          : `MusicBrainz relates ${named.join(', ')} to a work`,
    };
  }
  if (queueStatus === 'not_classical') {
    return {
      spotifyTrackId,
      state: 'not_classical',
      provenance: 'llm_proposal',
      reason: 'the album parser ruled this not classical; not reviewed by hand',
    };
  }
  return {
    spotifyTrackId,
    state: 'unreviewed',
    provenance: 'musicbrainz',
    reason:
      evidenceMbids.length > 0
        ? `${evidenceMbids.join(', ')} has no work relationship in the cache`
        : 'no MusicBrainz evidence yet',
  };
}

/** Walks up the parent chain, then takes one generation of children so the
 *  reader can tell a work that has parts from a leaf. */
async function readWorkTree(
  seedMbids: string[],
  database: DatabaseExecutor,
): Promise<MbWorkFact[]> {
  const byMbid = new Map<string, MbWorkFact>();
  let frontier = Array.from(new Set(seedMbids));
  for (let generation = 0; generation < MAX_WORK_GENERATIONS && frontier.length > 0; generation++) {
    const rows = await forChunks(frontier, (chunk) =>
      database.select().from(mbWork).where(inArray(mbWork.mbid, chunk)),
    );
    for (const row of rows) byMbid.set(row.mbid, row);
    frontier = rows
      .map((row) => row.parentMbid)
      .filter((mbid): mbid is string => mbid !== null && !byMbid.has(mbid));
  }
  const children = await forChunks(byMbid.keys(), (chunk) =>
    database.select().from(mbWork).where(inArray(mbWork.parentMbid, chunk)),
  );
  for (const row of children) if (!byMbid.has(row.mbid)) byMbid.set(row.mbid, row);
  return Array.from(byMbid.values()).map((row) => ({
    mbid: row.mbid,
    title: row.title,
    type: row.type,
    parentMbid: row.parentMbid,
    orderingKey: row.orderingKey,
    composerMbid: row.composerMbid,
    detail: row.detail,
  }));
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
  };
}
