import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  ne,
  notLike,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
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
  mbWorkProposal,
  spotifyAlbum,
  spotifyTrack,
  trackArtists,
  trackClassification,
  trackRecording,
  trackWorkLink,
} from '@/lib/db/schema';
import { filmScoreReason } from '@/lib/film-scores';
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
  OwnWorkLinkFact,
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
  return loadMusicBrainzFacts(spotifyTrackIds, database, true);
}

/**
 * The pipeline must evaluate current MusicBrainz evidence before provenance
 * precedence is applied. Otherwise an old parser proposal would hide stronger
 * new evidence and could never be upgraded.
 */
export async function loadDerivedMusicBrainzLibraryFacts(
  spotifyTrackIds: string[],
  database: DatabaseExecutor = db,
): Promise<MusicBrainzLibraryFacts> {
  return loadMusicBrainzFacts(spotifyTrackIds, database, false);
}

async function loadMusicBrainzFacts(
  spotifyTrackIds: string[],
  database: DatabaseExecutor,
  preferStoredClassifications: boolean,
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

  const [
    recordingRows,
    recordingWorkRows,
    creditRows,
    queueRows,
    storedClassificationRows,
    isrcRows,
    releaseRows,
    trackArtistRows,
  ] = await Promise.all([
    forChunks(recordingMbids, (chunk) =>
      database.select().from(mbRecording).where(inArray(mbRecording.mbid, chunk)),
    ),
    forChunks(recordingMbids, (chunk) =>
      database.select().from(mbRecordingWork).where(inArray(mbRecordingWork.recordingMbid, chunk)),
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
    forChunks(requestedTrackIds, (chunk) =>
      database
        .select({
          spotifyTrackId: spotifyTrack.spotifyId,
          state: trackClassification.state,
          provenance: trackClassification.provenance,
          reason: trackClassification.reason,
        })
        .from(spotifyTrack)
        .leftJoin(
          trackClassification,
          eq(trackClassification.spotifyTrackId, spotifyTrack.spotifyId),
        )
        .where(inArray(spotifyTrack.spotifyId, chunk)),
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
    forChunks(requestedTrackIds, (chunk) =>
      database.select().from(trackArtists).where(inArray(trackArtists.spotifyTrackId, chunk)),
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
  const storedClassificationByTrack = new Map<string, TrackClassification>();
  for (const row of storedClassificationRows) {
    if (row.state === null || row.provenance === null) continue;
    storedClassificationByTrack.set(row.spotifyTrackId, {
      spotifyTrackId: row.spotifyTrackId,
      state: row.state,
      provenance: row.provenance,
      reason: row.reason,
    });
  }
  const artistIdsByTrack = new Map<string, string[]>();
  for (const row of trackArtistRows) {
    artistIdsByTrack.set(row.spotifyTrackId, [
      ...(artistIdsByTrack.get(row.spotifyTrackId) ?? []),
      row.spotifyArtistId,
    ]);
  }
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

  const ownWorkLinks = await loadOwnWorkLinks(
    requestedTrackIds.filter((spotifyTrackId) => !anchorByTrackId.has(spotifyTrackId)),
    [...recordingMbids].filter((recordingMbid) => !worksByRecording.has(recordingMbid)),
    database,
  );
  const ownWorksByTrack = new Map<string, string[]>();
  for (const link of ownWorkLinks) {
    if (link.subject === 'track') ownWorksByTrack.set(link.spotifyTrackId, [link.workMbid]);
    else worksByRecording.set(link.recordingMbid, [link.workMbid]);
  }

  const workRows = await readWorkTree(
    [
      ...recordingWorkRows.map((relation) => relation.workMbid),
      ...candidateWorkRows.map((relation) => relation.workMbid),
      ...ownWorkLinks.map((link) => link.workMbid),
    ],
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

  const catalogedComposerMbids = new Set(
    (
      await forChunks(
        workRows.map((work) => work.composerMbid).filter((mbid): mbid is string => !!mbid),
        (chunk) =>
          database
            .select({ composerMbid: mbWork.composerMbid })
            .from(mbWork)
            .innerJoin(mbWorkCatalogue, eq(mbWorkCatalogue.workMbid, mbWork.mbid))
            .innerJoin(mbArtist, eq(mbArtist.mbid, mbWork.composerMbid))
            .where(and(inArray(mbWork.composerMbid, chunk), notLike(mbArtist.name, '[%'))),
      )
    ).map((row) => row.composerMbid!),
  );

  const providerTrackById = new Map(providerTrackRows.map((track) => [track.spotifyId, track]));
  const providerAlbumById = new Map(providerAlbumRows.map((album) => [album.spotifyId, album]));
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
      const musicBrainzWorks = evidenceMbids.flatMap((mbid) => worksByRecording.get(mbid) ?? []);
      // Our own link stands in only where MusicBrainz relates no work.
      const trackWorkMbids =
        musicBrainzWorks.length > 0
          ? musicBrainzWorks
          : (ownWorksByTrack.get(spotifyTrackId) ?? []);

      // A standing decision about what the catalogue holds, so it outranks
      // both a stored verdict and fresh MusicBrainz evidence. Read here
      // rather than stored, so it covers albums imported later too.
      const album = track ? providerAlbumById.get(track.spotifyAlbumId) : undefined;
      const filmScore = filmScoreReason(
        {
          workMbids: trackWorkMbids,
          spotifyArtistIds: artistIdsByTrack.get(spotifyTrackId) ?? [],
          album: album ? { spotifyAlbumId: album.spotifyId, title: album.title } : null,
        },
        workByMbid,
        catalogedWorkMbids,
      );
      if (filmScore) {
        return [
          { spotifyTrackId, state: 'not_classical', provenance: 'manual', reason: filmScore },
        ];
      }

      const stored = storedClassificationByTrack.get(spotifyTrackId);
      if (preferStoredClassifications && stored) return [stored];

      const classification = classify(
        spotifyTrackId,
        trackWorkMbids,
        workByMbid,
        catalogedWorkMbids,
        catalogedComposerMbids,
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
    ownWorkLinks,
    mbCatalogedComposerMbids: [...catalogedComposerMbids],
  };
}

/**
 * Our own work links for what MusicBrainz does not link: tracks with no
 * MusicBrainz recording that `track_work_link` linked confidently, and
 * recordings with no MusicBrainz work that `mb_work_proposal` suggests one
 * for (every suggestion nobody dismissed, at its own confidence).
 */
async function loadOwnWorkLinks(
  unanchoredTrackIds: string[],
  worklessRecordingMbids: string[],
  database: DatabaseExecutor,
): Promise<OwnWorkLinkFact[]> {
  const [trackRows, proposalRows] = await Promise.all([
    forChunks(unanchoredTrackIds, (chunk) =>
      database
        .select({ spotifyTrackId: trackWorkLink.spotifyTrackId, workMbid: trackWorkLink.workMbid })
        .from(trackWorkLink)
        .where(
          and(inArray(trackWorkLink.spotifyTrackId, chunk), isNotNull(trackWorkLink.workMbid)),
        ),
    ),
    forChunks(worklessRecordingMbids, (chunk) =>
      database
        .select({
          recordingMbid: mbWorkProposal.recordingMbid,
          proposal: mbWorkProposal.proposal,
        })
        .from(mbWorkProposal)
        .where(
          and(
            inArray(mbWorkProposal.recordingMbid, chunk),
            ne(mbWorkProposal.status, 'dismissed'),
            isNotNull(mbWorkProposal.proposal),
          ),
        ),
    ),
  ]);
  return [
    ...trackRows.map(
      (row): OwnWorkLinkFact => ({
        subject: 'track',
        spotifyTrackId: row.spotifyTrackId,
        workMbid: row.workMbid!,
        confidence: 'high',
      }),
    ),
    ...proposalRows.flatMap((row): OwnWorkLinkFact[] =>
      row.proposal?.workMbid
        ? [
            {
              subject: 'recording',
              recordingMbid: row.recordingMbid,
              workMbid: row.proposal.workMbid,
              confidence: row.proposal.confidence,
            },
          ]
        : [],
    ),
  ];
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
  workByMbid: Map<
    string,
    { mbid: string; type: string | null; parentMbid: string | null; composerMbid: string | null }
  >,
  catalogedWorkMbids: Set<string>,
  catalogedComposerMbids: Set<string>,
  queueStatus: string | null,
): TrackClassification {
  const evidence = classicalEvidenceFor(
    workMbids,
    workByMbid,
    catalogedWorkMbids,
    catalogedComposerMbids,
  );
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
    ownWorkLinks: [],
    mbCatalogedComposerMbids: [],
  };
}

export type OwnWorkHolding = {
  /** A MusicBrainz recording MBID, or `track:<spotify id>` for a track with no recording. */
  holdingKey: string;
  workMbid: string;
  spotifyTrackId: string;
  spotifyAlbumId: string;
  albumTitle: string;
};

/**
 * Where our own work links stand in for MusicBrainz's, as the player uses
 * them (see `loadOwnWorkLinks`): tracks with no MusicBrainz recording linked
 * by `track_work_link`, and anchored recordings with no MusicBrainz work that
 * `mb_work_proposal` suggests one for. Every one, or only those of these works.
 */
export async function ownWorkHoldings(
  workMbids: string[] | null,
  database: DatabaseExecutor = db,
): Promise<OwnWorkHolding[]> {
  const proposedWork = sql<string>`json_extract(${mbWorkProposal.proposal}, '$.workMbid')`;
  const read = async (chunk: string[] | null): Promise<OwnWorkHolding[]> => {
    const [tracks, recordings] = await Promise.all([
      database
        .select({
          spotifyTrackId: trackWorkLink.spotifyTrackId,
          workMbid: trackWorkLink.workMbid,
          spotifyAlbumId: spotifyAlbum.spotifyId,
          albumTitle: spotifyAlbum.title,
        })
        .from(trackWorkLink)
        .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackWorkLink.spotifyTrackId))
        .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
        .leftJoin(trackRecording, eq(trackRecording.spotifyTrackId, trackWorkLink.spotifyTrackId))
        .where(
          and(
            isNotNull(trackWorkLink.workMbid),
            isNull(trackRecording.spotifyTrackId),
            chunk ? inArray(trackWorkLink.workMbid, chunk) : undefined,
          ),
        ),
      database
        .select({
          recordingMbid: mbWorkProposal.recordingMbid,
          workMbid: proposedWork,
          spotifyTrackId: trackRecording.spotifyTrackId,
          spotifyAlbumId: spotifyAlbum.spotifyId,
          albumTitle: spotifyAlbum.title,
        })
        .from(mbWorkProposal)
        .innerJoin(trackRecording, eq(trackRecording.recordingMbid, mbWorkProposal.recordingMbid))
        .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId))
        .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
        .where(
          and(
            ne(mbWorkProposal.status, 'dismissed'),
            isNotNull(proposedWork),
            sql`not exists (select 1 from ${mbRecordingWork} where ${mbRecordingWork.recordingMbid} = ${mbWorkProposal.recordingMbid})`,
            chunk ? inArray(proposedWork, chunk) : undefined,
          ),
        ),
    ]);
    return [
      ...tracks.map((row) => ({
        holdingKey: `track:${row.spotifyTrackId}`,
        workMbid: row.workMbid!,
        spotifyTrackId: row.spotifyTrackId,
        spotifyAlbumId: row.spotifyAlbumId,
        albumTitle: row.albumTitle,
      })),
      ...recordings.map((row) => ({
        holdingKey: row.recordingMbid,
        workMbid: row.workMbid,
        spotifyTrackId: row.spotifyTrackId,
        spotifyAlbumId: row.spotifyAlbumId,
        albumTitle: row.albumTitle,
      })),
    ];
  };
  return workMbids ? forChunks(workMbids, read) : read(null);
}

/**
 * Every track on the same Spotify albums as these, these included. Liking one
 * movement still puts the whole album's performance of the work on the card,
 * and the rest of it has to be read to be playable. Album-mates with neither a
 * recording nor one of our work links can't land on a card, so they're not
 * read.
 */
export async function findAlbumMateTrackIds(
  spotifyTrackIds: string[],
  database: DatabaseExecutor = db,
): Promise<string[]> {
  const albums = await forChunks(Array.from(new Set(spotifyTrackIds)), (chunk) =>
    database
      .select({ spotifyAlbumId: spotifyTrack.spotifyAlbumId })
      .from(spotifyTrack)
      .where(inArray(spotifyTrack.spotifyId, chunk)),
  );
  const mates = await forChunks(
    Array.from(new Set(albums.map((album) => album.spotifyAlbumId))),
    (chunk) =>
      database
        .select({ spotifyId: spotifyTrack.spotifyId })
        .from(spotifyTrack)
        .where(
          and(
            inArray(spotifyTrack.spotifyAlbumId, chunk),
            or(
              exists(
                database
                  .select({ one: sql`1` })
                  .from(trackRecording)
                  .where(eq(trackRecording.spotifyTrackId, spotifyTrack.spotifyId)),
              ),
              exists(
                database
                  .select({ one: sql`1` })
                  .from(trackWorkLink)
                  .where(
                    and(
                      eq(trackWorkLink.spotifyTrackId, spotifyTrack.spotifyId),
                      isNotNull(trackWorkLink.workMbid),
                    ),
                  ),
              ),
            ),
          ),
        ),
  );
  return Array.from(new Set([...spotifyTrackIds, ...mates.map((mate) => mate.spotifyId)]));
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
  const tree = subtreeOf(sql`select ${workMbid}`);
  const [workMbids, anchors] = await Promise.all([
    descendantWorkMbids(workMbid, database),
    database
      .select({ spotifyTrackId: trackRecording.spotifyTrackId })
      .from(trackRecording)
      .innerJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, trackRecording.recordingMbid))
      .where(sql`${mbRecordingWork.workMbid} in ${tree}`),
  ]);
  const own = await ownWorkHoldings(workMbids, database);
  return Array.from(
    new Set([
      ...anchors.map((anchor) => anchor.spotifyTrackId),
      ...own.map((holding) => holding.spotifyTrackId),
    ]),
  );
}

/** Other works by the same composer that we hold a recording of. */
export async function findProviderTracksForComposer(
  composerMbid: string,
  excludeWorkMbid: string,
  workLimit = 12,
  database: DatabaseExecutor = db,
): Promise<string[]> {
  // Every work tree of the composer is read in one pass, rather than one
  // walk per work: a prolific composer has hundreds of top-level works, and
  // a round trip each was most of a work page's load time.
  const tree = subtreeOf(
    sql`select w.mbid from mb_work w where w.composer_mbid = ${composerMbid} and w.parent_mbid is null`,
  );
  const [excludedMbids, works, nodes, anchors, own] = await Promise.all([
    descendantWorkMbids(excludeWorkMbid, database),
    database
      .select({ mbid: mbWork.mbid })
      .from(mbWork)
      .where(and(eq(mbWork.composerMbid, composerMbid), isNull(mbWork.parentMbid))),
    database
      .select({ mbid: mbWork.mbid, parentMbid: mbWork.parentMbid })
      .from(mbWork)
      .where(sql`${mbWork.mbid} in ${tree}`),
    database
      .select({ workMbid: mbRecordingWork.workMbid, spotifyTrackId: trackRecording.spotifyTrackId })
      .from(trackRecording)
      .innerJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, trackRecording.recordingMbid))
      .where(sql`${mbRecordingWork.workMbid} in ${tree}`),
    ownWorkHoldings(null, database),
  ]);

  // Which top-level work each node of the trees is filed under.
  const parentOf = new Map(nodes.map((node) => [node.mbid, node.parentMbid]));
  const rootOf = new Map<string, string>();
  const findRoot = (mbid: string): string | null => {
    const seen = new Set<string>();
    let current = mbid;
    while (!seen.has(current)) {
      seen.add(current);
      const parent = parentOf.get(current);
      if (parent === undefined) return null;
      if (parent === null) return current;
      current = parent;
    }
    return null;
  };
  for (const node of nodes) {
    const root = findRoot(node.mbid);
    if (root) rootOf.set(node.mbid, root);
  }

  const tracksByRoot = new Map<string, string[]>();
  const file = (workMbid: string, spotifyTrackId: string) => {
    const root = rootOf.get(workMbid);
    if (!root) return;
    tracksByRoot.set(root, [...(tracksByRoot.get(root) ?? []), spotifyTrackId]);
  };
  for (const anchor of anchors) file(anchor.workMbid, anchor.spotifyTrackId);
  for (const holding of own) file(holding.workMbid, holding.spotifyTrackId);

  const excluded = new Set(excludedMbids);
  const trackIds: string[] = [];
  for (const work of works) {
    if (excluded.has(work.mbid) || trackIds.length >= workLimit * 32) continue;
    trackIds.push(...new Set(tracksByRoot.get(work.mbid) ?? []));
  }
  return Array.from(new Set(trackIds));
}

/**
 * The MBIDs of the works under the seed works, the seeds included, as a
 * subquery. UNION (not UNION ALL) drops a work already reached, so a cycle in
 * the cache ends the walk instead of looping.
 */
function subtreeOf(seed: SQL) {
  return sql`(with recursive tree(mbid) as (${seed} union select child.mbid from mb_work child join tree on child.parent_mbid = tree.mbid) select mbid from tree)`;
}

/** A work and everything filed beneath it. */
async function descendantWorkMbids(
  workMbid: string,
  database: DatabaseExecutor,
): Promise<string[]> {
  const rows = await database
    .select({ mbid: mbWork.mbid })
    .from(mbWork)
    .where(sql`${mbWork.mbid} in ${subtreeOf(sql`select ${workMbid}`)}`);
  return Array.from(new Set([workMbid, ...rows.map((row) => row.mbid)]));
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
  for (const holding of await ownWorkHoldings([...rootOf.keys()], database)) {
    const root = rootOf.get(holding.workMbid);
    if (root) held.add(root);
  }
  return held;
}

/** The composer MusicBrainz files on this work, if the cache has one. */
export async function readWorkComposerMbid(
  workMbid: string,
  database: DatabaseExecutor = db,
): Promise<string | null> {
  const [row] = await database
    .select({ composerMbid: mbWork.composerMbid })
    .from(mbWork)
    .where(eq(mbWork.mbid, workMbid))
    .limit(1);
  return row?.composerMbid ?? null;
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
