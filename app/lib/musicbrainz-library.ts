import { workLevelOf } from './musicbrainz-work-level';
import type {
  AcceptedAnchorFact,
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
  TrackAnchorFact,
  TrackClassification,
} from './musicbrainz-library-facts';

/**
 * The MusicBrainz-authoritative reader projection: pure, IO-free, and fed
 * only by `MusicBrainzLibraryFacts`, so the authority boundary is
 * mechanically testable. What it cannot show, it reports as a typed gap
 * rather than filling in.
 */

export type MusicBrainzGapCode =
  | 'provider-track-not-fetched'
  | 'provider-album-not-fetched'
  | 'classification-unreviewed'
  | 'classification-uncertain'
  | 'classification-not-classical'
  | 'release-not-checked'
  | 'release-missing'
  | 'release-ambiguous'
  | 'release-tracklist-misaligned'
  | 'release-cache-missing'
  | 'release-title-missing'
  | 'release-date-missing'
  | 'release-track-position-mismatch'
  | 'recording-unanchored'
  | 'recording-anchor-conflict'
  | 'recording-cache-missing'
  | 'recording-stub'
  | 'recording-title-missing'
  | 'recording-work-missing'
  | 'work-cache-missing'
  | 'work-stub'
  | 'work-title-missing'
  | 'work-type-missing'
  | 'work-catalogue-missing'
  | 'work-composer-missing'
  | 'composer-cache-missing'
  | 'composer-name-missing'
  | 'work-hierarchy-parent-missing'
  | 'work-hierarchy-cycle'
  | 'work-level-ambiguous'
  | 'recording-credits-missing'
  | 'recording-credit-artist-missing';

export type MusicBrainzGap = {
  code: MusicBrainzGapCode;
  entity: 'track' | 'album' | 'recording' | 'work' | 'artist' | 'release';
  entityId: string;
  detail: string | null;
};

export type AccountedTrackStatus = 'ready' | 'incomplete' | 'unmatched' | 'unclassified';

export type AccountedTrack = {
  spotifyTrackId: string;
  status: AccountedTrackStatus;
  recordingMbid: string | null;
  gapCodes: MusicBrainzGapCode[];
};

export type ProjectedCatalogueReference = {
  /**
   * The work in the hierarchy that actually carries this reference. A
   * movement rarely has its own catalogue number — BWV 988 is filed against
   * the Goldberg Variations, not against its Aria — so the reader has to be
   * able to say which work the number describes.
   */
  fromWorkMbid: string;
  seriesMbid: string;
  system: string;
  number: string;
  normalizedSystem: string;
  normalizedNumber: string;
};

export type ProjectedComposer = {
  mbid: string;
  name: string | null;
  creditedName: string | null;
  sortName: string | null;
  type: string | null;
  beginYear: number | null;
  endYear: number | null;
};

export type ProjectedWorkNode = {
  mbid: string;
  title: string | null;
  type: string | null;
  orderingKey: number | null;
  detail: 'stub' | 'full';
};

export type ProjectedRecordingWork = {
  /** The work MusicBrainz relates directly to the recording. */
  relatedWorkMbid: string;
  /** The conservative reader level selected by `workLevelOf`. */
  displayWorkMbid: string | null;
  workLevelReason: 'has-parts' | 'typed' | 'no-parent' | 'titled-as-part' | 'unresolved' | null;
  hierarchy: ProjectedWorkNode[];
  title: string | null;
  type: string | null;
  catalogues: ProjectedCatalogueReference[];
  composer: ProjectedComposer | null;
  gaps: MusicBrainzGap[];
};

export type ProjectedCredit = {
  artistMbid: string;
  name: string | null;
  creditedName: string | null;
  role: string;
  instrument: string | null;
};

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
  /** Number of accepted MusicBrainz anchors on this provider album. */
  albumAnchoredTrackCount: number;
  releaseMbid: string | null;
  releaseTitle: string | null;
  releaseDate: string | null;
  releaseTrackTitle: string | null;
  gaps: MusicBrainzGap[];
};

export type ProjectedRecording = {
  recordingMbid: string;
  title: string | null;
  lengthMs: number | null;
  /** Null when the recording is not in the cache at all — we know nothing yet. */
  detail: 'stub' | 'full' | null;
  heldTrackIds: string[];
  works: ProjectedRecordingWork[];
  credits: ProjectedCredit[];
  occurrences: ProjectedProviderOccurrence[];
  preferredOccurrence: ProjectedProviderOccurrence | null;
  gaps: MusicBrainzGap[];
};

/**
 * What MusicBrainz already says about a track that is not in the library.
 *
 * Reading metadata and deciding whether a track is classical are separate
 * questions, and a track held back on the second still deserves the first: a
 * reviewer looking at a track we filed as uncertain needs to see the
 * recording, the work and the composer MusicBrainz already gave us, not an
 * empty row with a label on it.
 */
export type UnresolvedTrackMetadata = {
  recordingMbid: string;
  recordingTitle: string | null;
  detail: 'stub' | 'full' | null;
  works: ProjectedRecordingWork[];
  credits: ProjectedCredit[];
};

export type UnresolvedLibraryTrack = {
  spotifyTrackId: string;
  providerTitle: string | null;
  spotifyAlbumId: string | null;
  status: 'unmatched' | 'unclassified';
  classification: TrackClassification | null;
  /** Null only when nothing anchored the track to a MusicBrainz recording. */
  musicBrainz: UnresolvedTrackMetadata | null;
  gaps: MusicBrainzGap[];
};

export type MusicBrainzLibraryProjection = {
  /** Input IDs as a set, preserving first-seen order. */
  requestedTrackIds: string[];
  recordings: ProjectedRecording[];
  unresolvedTracks: UnresolvedLibraryTrack[];
  accounting: AccountedTrack[];
};

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function pushGap(gaps: MusicBrainzGap[], gap: MusicBrainzGap): void {
  const duplicate = gaps.some(
    (candidate) =>
      candidate.code === gap.code &&
      candidate.entity === gap.entity &&
      candidate.entityId === gap.entityId &&
      candidate.detail === gap.detail,
  );
  if (!duplicate) gaps.push(gap);
}

function gap(
  code: MusicBrainzGapCode,
  entity: MusicBrainzGap['entity'],
  entityId: string,
  detail: string | null = null,
): MusicBrainzGap {
  return { code, entity, entityId, detail };
}

function oneByKey<T>(items: T[], keyOf: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) result.set(keyOf(item), item);
  return result;
}

function manyByKey<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = result.get(key);
    if (group) group.push(item);
    else result.set(key, [item]);
  }
  return result;
}

function compareNullableNumberDescending(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

/**
 * Every lookup the projection needs, built once per call. The projection is
 * run over a whole liked library, so rebuilding these per recording or per
 * work is the difference between linear and quadratic.
 */
type LibraryIndex = {
  classificationByTrack: Map<string, TrackClassification>;
  albumById: Map<string, ProviderAlbumFact>;
  trackById: Map<string, ProviderTrackFact>;
  anchorByTrack: Map<string, TrackAnchorFact>;
  anchorsByRecording: Map<string, AcceptedAnchorFact[]>;
  acceptedAnchorCountByAlbum: Map<string, number>;
  recordingById: Map<string, MbRecordingFact>;
  worksByRecording: Map<string, MbRecordingWorkFact[]>;
  workById: Map<string, MbWorkFact>;
  parentWorkMbids: Set<string>;
  catalogueByWork: Map<string, MbWorkCatalogueFact[]>;
  artistById: Map<string, MbArtistFact>;
  creditsByRecording: Map<string, MbRecordingCreditFact[]>;
  releaseById: Map<string, MbReleaseFact>;
  releaseTrackByPosition: Map<string, MbReleaseTrackFact>;
};

function indexFacts(facts: MusicBrainzLibraryFacts): LibraryIndex {
  const trackById = oneByKey(facts.providerTracks, (track) => track.spotifyTrackId);
  const acceptedAnchors = facts.anchors.filter(
    (anchor): anchor is AcceptedAnchorFact => anchor.state === 'accepted',
  );
  const acceptedAnchorCountByAlbum = new Map<string, number>();
  for (const anchor of acceptedAnchors) {
    const track = trackById.get(anchor.spotifyTrackId);
    if (!track) continue;
    acceptedAnchorCountByAlbum.set(
      track.spotifyAlbumId,
      (acceptedAnchorCountByAlbum.get(track.spotifyAlbumId) ?? 0) + 1,
    );
  }
  return {
    classificationByTrack: oneByKey(
      facts.classifications,
      (classification) => classification.spotifyTrackId,
    ),
    albumById: oneByKey(facts.providerAlbums, (album) => album.spotifyAlbumId),
    trackById,
    anchorByTrack: oneByKey(facts.anchors, (anchor) => anchor.spotifyTrackId),
    anchorsByRecording: manyByKey(acceptedAnchors, (anchor) => anchor.recordingMbid),
    acceptedAnchorCountByAlbum,
    recordingById: oneByKey(facts.mbRecordings, (recording) => recording.mbid),
    worksByRecording: manyByKey(facts.mbRecordingWorks, (relation) => relation.recordingMbid),
    workById: oneByKey(facts.mbWorks, (work) => work.mbid),
    parentWorkMbids: new Set(
      facts.mbWorks.map((work) => work.parentMbid).filter((mbid): mbid is string => mbid !== null),
    ),
    catalogueByWork: manyByKey(facts.mbWorkCatalogues, (catalogue) => catalogue.workMbid),
    artistById: oneByKey(facts.mbArtists, (artist) => artist.mbid),
    creditsByRecording: manyByKey(facts.mbRecordingCredits, (credit) => credit.recordingMbid),
    releaseById: oneByKey(facts.mbReleases, (release) => release.mbid),
    releaseTrackByPosition: oneByKey(
      facts.mbReleaseTracks,
      (track) => `${track.releaseMbid}:${track.medium}:${track.position}`,
    ),
  };
}

/**
 * Build the MusicBrainz-only reader projection. This function performs no IO
 * and accepts no legacy/parser facts, which makes the authority boundary
 * mechanically testable.
 */
export function projectMusicBrainzLibrary(
  facts: MusicBrainzLibraryFacts,
): MusicBrainzLibraryProjection {
  const requestedTrackIds = Array.from(new Set(facts.requestedTrackIds));
  const requestedOrder = new Map(requestedTrackIds.map((id, index) => [id, index]));

  const index = indexFacts(facts);
  const { trackById, classificationByTrack, anchorByTrack } = index;

  const recordingIds = new Set<string>();
  // Requested tracks this projection actually accepted into a recording. A
  // track we sent to a gap bucket — unreviewed, uncertain, deliberately not
  // classical, anchor in conflict — must not be pulled back in as a held
  // occurrence just because it shares a recording with a track that resolved.
  const heldByRecording = new Map<string, Set<string>>();
  const unresolvedTracks: UnresolvedLibraryTrack[] = [];
  const accountingByTrack = new Map<string, AccountedTrack>();

  const addUnresolved = (
    spotifyTrackId: string,
    status: 'unmatched' | 'unclassified',
    classification: TrackClassification | null,
    gaps: MusicBrainzGap[],
    musicBrainz: UnresolvedTrackMetadata | null = null,
  ): void => {
    const providerTrack = trackById.get(spotifyTrackId);
    unresolvedTracks.push({
      spotifyTrackId,
      providerTitle: providerTrack?.title ?? null,
      spotifyAlbumId: providerTrack?.spotifyAlbumId ?? null,
      status,
      classification,
      musicBrainz,
      gaps,
    });
    accountingByTrack.set(spotifyTrackId, {
      spotifyTrackId,
      status,
      recordingMbid: null,
      gapCodes: gaps.map((item) => item.code),
    });
  };

  for (const spotifyTrackId of requestedTrackIds) {
    const providerTrack = trackById.get(spotifyTrackId);
    const classification = classificationByTrack.get(spotifyTrackId) ?? null;
    const anchor = anchorByTrack.get(spotifyTrackId);
    // Read first, route second. What MusicBrainz knows about the track does
    // not depend on whether we have decided the track is classical.
    const known =
      anchor?.state === 'accepted' ? describeAnchoredTrack(anchor.recordingMbid, index) : null;
    // A contested ISRC is a contradiction in MusicBrainz, and it is worth
    // reporting whatever the track's classification turns out to be.
    const contested =
      anchor?.state === 'conflicting'
        ? [
            gap(
              'recording-anchor-conflict',
              'track',
              spotifyTrackId,
              `${anchor.reason}; candidates: ${anchor.candidateRecordingMbids.join(', ')}`,
            ),
          ]
        : [];
    if (!providerTrack) {
      addUnresolved(spotifyTrackId, 'unmatched', classification, [
        gap('provider-track-not-fetched', 'track', spotifyTrackId),
      ]);
      continue;
    }

    if (!classification || classification.state === 'unreviewed') {
      addUnresolved(
        spotifyTrackId,
        'unclassified',
        classification,
        [
          gap('classification-unreviewed', 'track', spotifyTrackId, classification?.reason ?? null),
          ...contested,
        ],
        known,
      );
      continue;
    }
    if (classification.state === 'uncertain') {
      addUnresolved(
        spotifyTrackId,
        'unclassified',
        classification,
        [
          gap('classification-uncertain', 'track', spotifyTrackId, classification.reason),
          ...contested,
        ],
        known,
      );
      continue;
    }
    if (classification.state === 'not_classical') {
      addUnresolved(
        spotifyTrackId,
        'unclassified',
        classification,
        [
          gap('classification-not-classical', 'track', spotifyTrackId, classification.reason),
          ...contested,
        ],
        known,
      );
      continue;
    }

    if (!anchor) {
      const gaps = releaseGaps(providerTrack, index, null);
      pushGap(gaps, gap('recording-unanchored', 'track', spotifyTrackId));
      addUnresolved(spotifyTrackId, 'unmatched', classification, gaps);
      continue;
    }
    if (anchor.state === 'conflicting') {
      addUnresolved(spotifyTrackId, 'unmatched', classification, contested);
      continue;
    }

    recordingIds.add(anchor.recordingMbid);
    const held = heldByRecording.get(anchor.recordingMbid) ?? new Set<string>();
    held.add(spotifyTrackId);
    heldByRecording.set(anchor.recordingMbid, held);
  }

  const projected = Array.from(recordingIds).map((recordingMbid) =>
    projectRecording(recordingMbid, heldByRecording.get(recordingMbid) ?? new Set(), index),
  );
  const recordings = projected.map((entry) => entry.recording);
  for (const { recording, allGaps } of projected) {
    const gapCodes = Array.from(new Set(allGaps.map((item) => item.code)));
    for (const spotifyTrackId of recording.heldTrackIds) {
      accountingByTrack.set(spotifyTrackId, {
        spotifyTrackId,
        status: allGaps.length === 0 ? 'ready' : 'incomplete',
        recordingMbid: recording.recordingMbid,
        gapCodes,
      });
    }
  }

  recordings.sort((left, right) => left.recordingMbid.localeCompare(right.recordingMbid));
  unresolvedTracks.sort(
    (left, right) =>
      (requestedOrder.get(left.spotifyTrackId) ?? 0) -
      (requestedOrder.get(right.spotifyTrackId) ?? 0),
  );

  const accounting = requestedTrackIds.map((spotifyTrackId) => {
    const accounted = accountingByTrack.get(spotifyTrackId);
    if (accounted) return accounted;
    // This is a defensive, visible failure rather than a dropped input. It
    // should be unreachable because every branch above records the track.
    return {
      spotifyTrackId,
      status: 'unmatched' as const,
      recordingMbid: null,
      gapCodes: ['recording-unanchored' as const],
    };
  });

  return { requestedTrackIds, recordings, unresolvedTracks, accounting };
}

/**
 * One MusicBrainz recording with its provider occurrences. `heldTrackIds` are
 * the requested tracks this projection accepted here; other occurrences are
 * real alternatives we keep but do not claim the reader holds.
 */
function projectRecording(
  recordingMbid: string,
  heldTrackIds: Set<string>,
  index: LibraryIndex,
): { recording: ProjectedRecording; allGaps: MusicBrainzGap[] } {
  const recording = index.recordingById.get(recordingMbid);
  const recordingGaps: MusicBrainzGap[] = [];
  if (!recording) {
    pushGap(recordingGaps, gap('recording-cache-missing', 'recording', recordingMbid));
  } else {
    if (recording.detail === 'stub') {
      pushGap(recordingGaps, gap('recording-stub', 'recording', recordingMbid));
    }
    if (!nonBlank(recording.title)) {
      pushGap(recordingGaps, gap('recording-title-missing', 'recording', recordingMbid));
    }
  }

  const directWorkRelations = index.worksByRecording.get(recordingMbid) ?? [];
  if (directWorkRelations.length === 0) {
    pushGap(recordingGaps, gap('recording-work-missing', 'recording', recordingMbid));
  }
  const works = directWorkRelations
    .map((relation) => projectRecordingWork(relation.workMbid, index))
    .sort((left, right) => left.relatedWorkMbid.localeCompare(right.relatedWorkMbid));

  const rawCredits = index.creditsByRecording.get(recordingMbid) ?? [];
  if (rawCredits.length === 0) {
    pushGap(recordingGaps, gap('recording-credits-missing', 'recording', recordingMbid));
  }
  const credits = rawCredits
    .map((credit): ProjectedCredit => {
      const artist = index.artistById.get(credit.artistMbid);
      if (!artist) {
        pushGap(
          recordingGaps,
          gap('recording-credit-artist-missing', 'artist', credit.artistMbid, recordingMbid),
        );
      }
      return {
        artistMbid: credit.artistMbid,
        name: artist ? nonBlank(artist.name) : null,
        creditedName: artist ? nonBlank(artist.creditedName) : null,
        role: credit.role,
        instrument: nonBlank(credit.instrument),
      };
    })
    .sort(
      (left, right) =>
        left.role.localeCompare(right.role) || left.artistMbid.localeCompare(right.artistMbid),
    );

  const occurrenceAnchors = index.anchorsByRecording.get(recordingMbid) ?? [];
  const occurrences = occurrenceAnchors
    .map((anchor) => {
      const track = index.trackById.get(anchor.spotifyTrackId);
      if (!track) return null;
      return projectOccurrence(track, heldTrackIds, index, recordingMbid);
    })
    .filter((occurrence): occurrence is ProjectedProviderOccurrence => occurrence !== null)
    .sort(compareOccurrences);

  const preferredOccurrence = occurrences[0] ?? null;
  const heldInOrder = occurrences
    .filter((occurrence) => occurrence.held)
    .map((occurrence) => occurrence.spotifyTrackId)
    .sort();
  const allGaps = [
    ...recordingGaps,
    ...works.flatMap((work) => work.gaps),
    ...heldInOrder.flatMap((trackId) => {
      const occurrence = occurrences.find((candidate) => candidate.spotifyTrackId === trackId);
      return occurrence?.gaps ?? [];
    }),
  ];

  return {
    allGaps,
    recording: {
      recordingMbid,
      title: recording ? nonBlank(recording.title) : null,
      lengthMs: recording?.lengthMs ?? null,
      detail: recording?.detail ?? null,
      heldTrackIds: heldInOrder,
      works,
      credits,
      occurrences,
      preferredOccurrence,
      gaps: recordingGaps,
    },
  };
}

function projectRecordingWork(
  relatedWorkMbid: string,
  index: LibraryIndex,
): ProjectedRecordingWork {
  const { workById, parentWorkMbids, catalogueByWork, artistById } = index;
  const gaps: MusicBrainzGap[] = [];
  const relatedWork = workById.get(relatedWorkMbid);
  if (!relatedWork) {
    pushGap(gaps, gap('work-cache-missing', 'work', relatedWorkMbid));
    return {
      relatedWorkMbid,
      displayWorkMbid: null,
      workLevelReason: null,
      hierarchy: [],
      title: null,
      type: null,
      catalogues: [],
      composer: null,
      gaps,
    };
  }

  const hierarchyLeafFirst: MbWorkFact[] = [];
  const visited = new Set<string>();
  let cursor: MbWorkFact | undefined = relatedWork;
  while (cursor) {
    if (visited.has(cursor.mbid)) {
      pushGap(gaps, gap('work-hierarchy-cycle', 'work', cursor.mbid));
      break;
    }
    visited.add(cursor.mbid);
    hierarchyLeafFirst.push(cursor);
    if (!cursor.parentMbid) break;
    const parent = workById.get(cursor.parentMbid);
    if (!parent) {
      pushGap(
        gaps,
        gap('work-hierarchy-parent-missing', 'work', cursor.parentMbid, `child: ${cursor.mbid}`),
      );
      break;
    }
    cursor = parent;
  }

  for (const work of hierarchyLeafFirst) {
    if (work.detail === 'stub') pushGap(gaps, gap('work-stub', 'work', work.mbid));
  }

  const parent = relatedWork.parentMbid ? workById.get(relatedWork.parentMbid) : undefined;
  const hasChildren = parentWorkMbids.has(relatedWork.mbid);
  const level = workLevelOf({
    mbid: relatedWork.mbid,
    title: relatedWork.title ?? '',
    type: relatedWork.type,
    parentMbid: relatedWork.parentMbid,
    parentTitle: parent?.title ?? null,
    hasChildren,
    orderingKey: relatedWork.orderingKey,
  });
  if (level.needsReview) {
    pushGap(gaps, gap('work-level-ambiguous', 'work', relatedWork.mbid, level.reason));
  }

  const displayWork = workById.get(level.mbid);
  if (!displayWork) {
    pushGap(gaps, gap('work-cache-missing', 'work', level.mbid));
  }
  const title = displayWork ? nonBlank(displayWork.title) : null;
  const type = displayWork ? nonBlank(displayWork.type) : null;
  if (!title) pushGap(gaps, gap('work-title-missing', 'work', level.mbid));
  if (!type) pushGap(gaps, gap('work-type-missing', 'work', level.mbid));

  // Nearest first: the display work's own references, else the closest
  // ancestor that has any. Climbing is reading MusicBrainz, not guessing —
  // MusicBrainz says this work is a part of that one, and that one is BWV
  // 988. Without it almost every movement would report a missing catalogue
  // and the reader could not group by catalogue number at all.
  const catalogueSource = catalogueAncestry(level.mbid, hierarchyLeafFirst).find(
    (candidate) => (catalogueByWork.get(candidate) ?? []).length > 0,
  );
  const catalogues = (catalogueSource ? (catalogueByWork.get(catalogueSource) ?? []) : [])
    .map(
      (catalogue): ProjectedCatalogueReference => ({
        fromWorkMbid: catalogue.workMbid,
        seriesMbid: catalogue.seriesMbid,
        system: catalogue.system,
        number: catalogue.number,
        normalizedSystem: catalogue.normalizedSystem,
        normalizedNumber: catalogue.normalizedNumber,
      }),
    )
    .sort(
      (left, right) =>
        left.normalizedSystem.localeCompare(right.normalizedSystem) ||
        left.normalizedNumber.localeCompare(right.normalizedNumber),
    );
  if (catalogues.length === 0) {
    pushGap(gaps, gap('work-catalogue-missing', 'work', level.mbid));
  }

  let composer: ProjectedComposer | null = null;
  if (!displayWork?.composerMbid) {
    pushGap(gaps, gap('work-composer-missing', 'work', level.mbid));
  } else {
    const artist = artistById.get(displayWork.composerMbid);
    if (!artist) {
      pushGap(gaps, gap('composer-cache-missing', 'artist', displayWork.composerMbid));
    } else {
      composer = {
        mbid: artist.mbid,
        name: nonBlank(artist.name),
        creditedName: nonBlank(artist.creditedName),
        sortName: nonBlank(artist.sortName),
        type: nonBlank(artist.type),
        beginYear: artist.beginYear,
        endYear: artist.endYear,
      };
      if (!composer.name) {
        pushGap(gaps, gap('composer-name-missing', 'artist', displayWork.composerMbid));
      }
    }
  }

  return {
    relatedWorkMbid,
    displayWorkMbid: displayWork?.mbid ?? null,
    workLevelReason: level.reason,
    hierarchy: [...hierarchyLeafFirst].reverse().map((work) => ({
      mbid: work.mbid,
      title: nonBlank(work.title),
      type: nonBlank(work.type),
      orderingKey: work.orderingKey,
      detail: work.detail,
    })),
    title,
    type,
    catalogues,
    composer,
    gaps,
  };
}

/** The MusicBrainz reading of a track, with no view on whether it belongs in
 *  the classical library. */
function describeAnchoredTrack(
  recordingMbid: string,
  index: LibraryIndex,
): UnresolvedTrackMetadata {
  const recording = index.recordingById.get(recordingMbid);
  return {
    recordingMbid,
    recordingTitle: recording ? nonBlank(recording.title) : null,
    detail: recording?.detail ?? null,
    works: (index.worksByRecording.get(recordingMbid) ?? []).map((relation) =>
      projectRecordingWork(relation.workMbid, index),
    ),
    credits: (index.creditsByRecording.get(recordingMbid) ?? []).map((credit) => {
      const artist = index.artistById.get(credit.artistMbid);
      return {
        artistMbid: credit.artistMbid,
        name: artist ? nonBlank(artist.name) : null,
        creditedName: artist ? nonBlank(artist.creditedName) : null,
        role: credit.role,
        instrument: nonBlank(credit.instrument),
      };
    }),
  };
}

/** The display work and then its ancestors, in the order to prefer them. */
function catalogueAncestry(displayWorkMbid: string, hierarchyLeafFirst: MbWorkFact[]): string[] {
  const chain = hierarchyLeafFirst.map((work) => work.mbid);
  const start = chain.indexOf(displayWorkMbid);
  return start === -1 ? [displayWorkMbid] : chain.slice(start);
}

function releaseGaps(
  track: ProviderTrackFact,
  index: LibraryIndex,
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

function projectOccurrence(
  track: ProviderTrackFact,
  heldTrackIds: Set<string>,
  index: LibraryIndex,
  recordingMbid: string,
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

function compareOccurrences(
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
