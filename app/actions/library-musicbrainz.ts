import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, type DatabaseExecutor } from '@/lib/db';
import { forChunks } from '@/lib/db/chunked';
import {
  mbArtist,
  mbRecording,
  mbRecordingCredit,
  mbRecordingIsrc,
  mbRecordingWork,
  mbRelease,
  mbReleaseTrack,
  mbReleaseUrl,
  mbWork,
  mbWorkCatalogue,
  matchQueue,
  spotifyAlbum,
  spotifyTrack,
  trackRecording,
} from '@/lib/db/schema';
import { classicalEvidenceFor } from '@/lib/musicbrainz-classical-evidence';
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

/**
 * A MusicBrainz work tree is recursive and arbitrarily deep, so the ancestors
 * are walked a generation at a time until the set stops growing. The bound is
 * a guard against a cycle in the cache, which the projection also reports.
 */
const MAX_WORK_GENERATIONS = 16;
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

  const [releaseTrackRows, releaseUrlRows] = await Promise.all([
    forChunks(
      releaseRows.map((release) => release.mbid),
      (chunk) =>
        database.select().from(mbReleaseTrack).where(inArray(mbReleaseTrack.releaseMbid, chunk)),
    ),
    forChunks(
      releaseRows.map((release) => release.mbid),
      (chunk) =>
        database.select().from(mbReleaseUrl).where(inArray(mbReleaseUrl.releaseMbid, chunk)),
    ),
  ]);
  const releasesWithSpotifyFreeStreaming = new Set(
    releaseUrlRows.filter(isSpotifyFreeStreamingRelation).map((relation) => relation.releaseMbid),
  );

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
  const worksByRecording = new Map<string, string[]>();
  for (const relation of [...recordingWorkRows, ...candidateWorkRows]) {
    worksByRecording.set(relation.recordingMbid, [
      ...(worksByRecording.get(relation.recordingMbid) ?? []),
      relation.workMbid,
    ]);
  }

  const workRows = await readWorkTree(
    [...recordingWorkRows, ...candidateWorkRows].map((relation) => relation.workMbid),
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

  const providerTrackById = new Map(providerTrackRows.map((track) => [track.spotifyId, track]));
  const workByMbid = new Map(workRows.map((work) => [work.mbid, work]));
  const catalogedWorkMbids = new Set(catalogueRows.map((catalogue) => catalogue.workMbid));
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
        evidenceMbids.flatMap((mbid) => worksByRecording.get(mbid) ?? []),
        workByMbid,
        catalogedWorkMbids,
        queueStatusByTrack.get(spotifyTrackId) ?? null,
      );
      return [classification];
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
        spotifyFreeStreamingUrlState:
          release.urlRelationsFetchedAt === null
            ? 'unknown'
            : releasesWithSpotifyFreeStreaming.has(release.mbid)
              ? 'present'
              : 'missing',
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
 * actually support and nothing more.
 *
 * Specific MusicBrainz evidence — a catalogue-series reference or an
 * art-music work type — is deterministic and outranks the parser, and where
 * they disagree the reason says so. A work relation on its own is not
 * evidence: MusicBrainz files works for popular songs too. `match_queue`'s
 * `not_classical` is an LLM verdict and is labelled the proposal it is.
 * Everything else stays visible as uncertain or unreviewed, which is the
 * honest reading of "nobody has established this".
 */
function classify(
  spotifyTrackId: string,
  workMbids: string[],
  workByMbid: Map<string, { mbid: string; type: string | null; parentMbid: string | null }>,
  catalogedWorkMbids: Set<string>,
  queueStatus: string | null,
): TrackClassification {
  const evidence = classicalEvidenceFor(workMbids, workByMbid, catalogedWorkMbids);
  if (evidence.state === 'classical') {
    return {
      spotifyTrackId,
      state: 'classical',
      provenance: 'musicbrainz',
      reason:
        queueStatus === 'not_classical'
          ? `${evidence.reason}, but the parser ruled this not classical`
          : evidence.reason,
    };
  }
  if (queueStatus === 'not_classical') {
    return {
      spotifyTrackId,
      state: 'not_classical',
      provenance: 'llm_proposal',
      reason: `the album parser ruled this not classical; not reviewed by hand (${evidence.reason})`,
    };
  }
  // We looked and MusicBrainz did not settle it. That is a different state
  // from never having looked, and the reader shows both.
  if (workMbids.length > 0) {
    return {
      spotifyTrackId,
      state: 'uncertain',
      provenance: 'musicbrainz',
      reason: evidence.reason,
    };
  }
  return {
    spotifyTrackId,
    state: 'unreviewed',
    provenance: 'musicbrainz',
    reason: evidence.reason,
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

/**
 * The Spotify tracks anchored to any recording of this work or of its parts.
 *
 * The reader's other screens start from a work rather than from a holding —
 * every recording of this work, more works by this composer — and this is
 * the join that gets from one to the other without touching a legacy table.
 */
export async function findProviderTracksForWork(
  workMbid: string,
  database: DatabaseExecutor = db,
): Promise<string[]> {
  const workMbids = await descendantWorkMbids(workMbid, database);
  const relations = await forChunks(workMbids, (chunk) =>
    database
      .select({ recordingMbid: mbRecordingWork.recordingMbid })
      .from(mbRecordingWork)
      .where(inArray(mbRecordingWork.workMbid, chunk)),
  );
  const anchors = await forChunks(
    relations.map((relation) => relation.recordingMbid),
    (chunk) =>
      database
        .select({ spotifyTrackId: trackRecording.spotifyTrackId })
        .from(trackRecording)
        .where(inArray(trackRecording.recordingMbid, chunk)),
  );
  return Array.from(new Set(anchors.map((anchor) => anchor.spotifyTrackId)));
}

/** Other works by the same composer that we hold a recording of. */
export async function findProviderTracksForComposer(
  composerMbid: string,
  excludeWorkMbid: string,
  workLimit = 12,
  database: DatabaseExecutor = db,
): Promise<string[]> {
  const excluded = new Set(await descendantWorkMbids(excludeWorkMbid, database));
  const works = await database
    .select({ mbid: mbWork.mbid })
    .from(mbWork)
    .where(and(eq(mbWork.composerMbid, composerMbid), isNull(mbWork.parentMbid)));
  const trackIds: string[] = [];
  for (const work of works) {
    if (excluded.has(work.mbid) || trackIds.length >= workLimit * 32) continue;
    trackIds.push(...(await findProviderTracksForWork(work.mbid, database)));
  }
  return Array.from(new Set(trackIds));
}

/** A work and everything filed beneath it, to a bounded depth. */
async function descendantWorkMbids(
  workMbid: string,
  database: DatabaseExecutor,
): Promise<string[]> {
  const found = new Set([workMbid]);
  let frontier = [workMbid];
  for (let depth = 0; depth < MAX_WORK_GENERATIONS && frontier.length > 0; depth++) {
    const children = await forChunks(frontier, (chunk) =>
      database.select({ mbid: mbWork.mbid }).from(mbWork).where(inArray(mbWork.parentMbid, chunk)),
    );
    frontier = children.map((child) => child.mbid).filter((mbid) => !found.has(mbid));
    for (const mbid of frontier) found.add(mbid);
  }
  return Array.from(found);
}

/**
 * Which of these works we hold something playable for, counting anything
 * filed beneath them.
 *
 * A collection's parts often have parts of their own — a prelude and fugue
 * is two recordings under one part of the Well-Tempered Clavier — so asking
 * only about the part's own recordings would report a collection as emptier
 * than it is. One breadth-first walk for the whole set, not one per work.
 */
export async function findHeldWorkMbids(
  workMbids: string[],
  database: DatabaseExecutor = db,
): Promise<Set<string>> {
  const rootOf = new Map(workMbids.map((mbid) => [mbid, mbid]));
  let frontier = Array.from(new Set(workMbids));
  for (let depth = 0; depth < MAX_WORK_GENERATIONS && frontier.length > 0; depth++) {
    const children = await forChunks(frontier, (chunk) =>
      database
        .select({ mbid: mbWork.mbid, parentMbid: mbWork.parentMbid })
        .from(mbWork)
        .where(inArray(mbWork.parentMbid, chunk)),
    );
    frontier = [];
    for (const child of children) {
      if (rootOf.has(child.mbid) || !child.parentMbid) continue;
      const root = rootOf.get(child.parentMbid);
      if (!root) continue;
      rootOf.set(child.mbid, root);
      frontier.push(child.mbid);
    }
  }

  const relations = await forChunks(rootOf.keys(), (chunk) =>
    database
      .select({ recordingMbid: mbRecordingWork.recordingMbid, workMbid: mbRecordingWork.workMbid })
      .from(mbRecordingWork)
      .where(inArray(mbRecordingWork.workMbid, chunk)),
  );
  const anchored = new Set(
    (
      await forChunks(
        relations.map((relation) => relation.recordingMbid),
        (chunk) =>
          database
            .select({ recordingMbid: trackRecording.recordingMbid })
            .from(trackRecording)
            .where(inArray(trackRecording.recordingMbid, chunk)),
      )
    ).map((row) => row.recordingMbid),
  );

  const held = new Set<string>();
  for (const relation of relations) {
    if (!anchored.has(relation.recordingMbid)) continue;
    const root = rootOf.get(relation.workMbid);
    if (root) held.add(root);
  }
  return held;
}

/** A work's parent and the parent's other parts, straight from the cache. */
export async function readWorkCollection(
  workMbid: string,
  database: DatabaseExecutor = db,
): Promise<{
  parentTitle: string;
  siblings: Array<{ mbid: string; title: string; orderingKey: number | null }>;
} | null> {
  const [self] = await database
    .select({ parentMbid: mbWork.parentMbid })
    .from(mbWork)
    .where(eq(mbWork.mbid, workMbid))
    .limit(1);
  if (!self?.parentMbid) return null;

  const [parent] = await database
    .select({ title: mbWork.title })
    .from(mbWork)
    .where(eq(mbWork.mbid, self.parentMbid))
    .limit(1);
  if (!parent) return null;

  const siblings = await database
    .select({ mbid: mbWork.mbid, title: mbWork.title, orderingKey: mbWork.orderingKey })
    .from(mbWork)
    .where(eq(mbWork.parentMbid, self.parentMbid));
  return {
    parentTitle: parent.title,
    siblings: siblings.sort(
      (left, right) =>
        (left.orderingKey ?? Number.MAX_SAFE_INTEGER) -
          (right.orderingKey ?? Number.MAX_SAFE_INTEGER) || left.mbid.localeCompare(right.mbid),
    ),
  };
}
