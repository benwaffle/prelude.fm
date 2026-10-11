import { indexWorks, resolveDisplayWork, type WorkIndex } from './musicbrainz-display-work';
import type {
  AcceptedAnchorFact,
  MbArtistFact,
  MbRecordingCreditFact,
  MbRecordingFact,
  MbRecordingWorkFact,
  MbWorkCatalogueFact,
  MbWorkFact,
  MusicBrainzLibraryFacts,
  OwnWorkLinkFact,
  ProviderTrackFact,
  TrackAnchorFact,
  TrackClassification,
} from './musicbrainz-library-facts';
import {
  gap,
  nonBlank,
  pushGap,
  type MusicBrainzGap,
  type MusicBrainzGapCode,
} from './musicbrainz-library-gaps';
import {
  compareOccurrences,
  projectOccurrence,
  releaseGaps,
  type OccurrenceIndex,
  type ProjectedProviderOccurrence,
} from './musicbrainz-library-occurrence';

export type { MusicBrainzGap, MusicBrainzGapCode } from './musicbrainz-library-gaps';
export type { ProjectedProviderOccurrence } from './musicbrainz-library-occurrence';

/**
 * The MusicBrainz-authoritative reader projection: pure, IO-free, and fed
 * only by `MusicBrainzLibraryFacts`, so the authority boundary is
 * mechanically testable. What it cannot show, it reports as a typed gap
 * rather than filling in.
 */

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
  /** The work MusicBrainz (or, see `linkedBy`, we) relate directly to the recording. */
  relatedWorkMbid: string;
  /**
   * `musicbrainz`: MusicBrainz relates the recording to this work.
   * `prelude`: MusicBrainz does not, and the link is our own match, at
   * `linkConfidence`. The work itself is still read from MusicBrainz.
   */
  linkedBy: 'musicbrainz' | 'prelude';
  linkConfidence: 'high' | 'medium' | 'low' | null;
  /** The conservative reader level selected by `workLevelOf`. */
  displayWorkMbid: string | null;
  workLevelReason: 'has-parts' | 'typed' | 'no-parent' | 'titled-as-part' | 'unresolved' | null;
  hierarchy: ProjectedWorkNode[];
  /**
   * The displayed work's own parts, in MusicBrainz's ordering. This is what
   * lets a reader show that a holding is partial — the movements of the work
   * a performance does not carry — without guessing how many there are.
   */
  parts: ProjectedWorkNode[];
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

export type ProjectedRecording = {
  /**
   * A MusicBrainz recording MBID, or for `source: 'track'` the key
   * `track:<spotify id>`, which names no MusicBrainz entity.
   */
  recordingMbid: string;
  /**
   * `musicbrainz`: a MusicBrainz recording. `track`: one Spotify track
   * MusicBrainz has no recording for, which we linked to a work ourselves.
   */
  source: 'musicbrainz' | 'track';
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
  /**
   * The work our own match links the track to, when MusicBrainz has no
   * recording for it. Set only for such tracks.
   */
  ownWorks?: ProjectedRecordingWork[];
  gaps: MusicBrainzGap[];
};

export type MusicBrainzLibraryProjection = {
  /** Input IDs as a set, preserving first-seen order. */
  requestedTrackIds: string[];
  recordings: ProjectedRecording[];
  unresolvedTracks: UnresolvedLibraryTrack[];
  accounting: AccountedTrack[];
};

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

/**
 * Every lookup the projection needs, built once per call. The projection is
 * run over a whole liked library, so rebuilding these per recording or per
 * work is the difference between linear and quadratic.
 */
type LibraryIndex = OccurrenceIndex & {
  classificationByTrack: Map<string, TrackClassification>;
  childWorksByParent: Map<string, MbWorkFact[]>;
  trackById: Map<string, ProviderTrackFact>;
  anchorByTrack: Map<string, TrackAnchorFact>;
  anchorsByRecording: Map<string, AcceptedAnchorFact[]>;
  recordingById: Map<string, MbRecordingFact>;
  worksByRecording: Map<string, MbRecordingWorkFact[]>;
  works: WorkIndex<MbWorkFact, MbWorkCatalogueFact>;
  artistById: Map<string, MbArtistFact>;
  creditsByRecording: Map<string, MbRecordingCreditFact[]>;
  ownWorkByTrack: Map<string, Extract<OwnWorkLinkFact, { subject: 'track' }>>;
  ownWorkByRecording: Map<string, Extract<OwnWorkLinkFact, { subject: 'recording' }>>;
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
    childWorksByParent: manyByKey(
      facts.mbWorks.filter((work) => work.parentMbid !== null),
      (work) => work.parentMbid!,
    ),
    albumById: oneByKey(facts.providerAlbums, (album) => album.spotifyAlbumId),
    trackById,
    anchorByTrack: oneByKey(facts.anchors, (anchor) => anchor.spotifyTrackId),
    anchorsByRecording: manyByKey(acceptedAnchors, (anchor) => anchor.recordingMbid),
    acceptedAnchorCountByAlbum,
    recordingById: oneByKey(facts.mbRecordings, (recording) => recording.mbid),
    worksByRecording: manyByKey(facts.mbRecordingWorks, (relation) => relation.recordingMbid),
    works: indexWorks(facts.mbWorks, facts.mbWorkCatalogues),
    artistById: oneByKey(facts.mbArtists, (artist) => artist.mbid),
    creditsByRecording: manyByKey(facts.mbRecordingCredits, (credit) => credit.recordingMbid),
    releaseById: oneByKey(facts.mbReleases, (release) => release.mbid),
    releaseTrackByPosition: oneByKey(
      facts.mbReleaseTracks,
      (track) => `${track.releaseMbid}:${track.medium}:${track.position}`,
    ),
    ownWorkByTrack: oneByKey(
      facts.ownWorkLinks.filter(
        (link): link is Extract<OwnWorkLinkFact, { subject: 'track' }> => link.subject === 'track',
      ),
      (link) => link.spotifyTrackId,
    ),
    ownWorkByRecording: oneByKey(
      facts.ownWorkLinks.filter(
        (link): link is Extract<OwnWorkLinkFact, { subject: 'recording' }> =>
          link.subject === 'recording',
      ),
      (link) => link.recordingMbid,
    ),
  };
}

/** Where a classification that is not `classical` sends the track. */
const HELD_BACK_GAP: Record<
  Exclude<TrackClassification['state'], 'classical'>,
  MusicBrainzGapCode
> = {
  unreviewed: 'classification-unreviewed',
  uncertain: 'classification-uncertain',
  not_classical: 'classification-not-classical',
};

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
  // Tracks with no MusicBrainz recording that we linked to a work ourselves.
  const ownTrackHoldings: string[] = [];
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
    const ownLink = anchorByTrack.has(spotifyTrackId)
      ? undefined
      : index.ownWorkByTrack.get(spotifyTrackId);
    unresolvedTracks.push({
      spotifyTrackId,
      providerTitle: providerTrack?.title ?? null,
      spotifyAlbumId: providerTrack?.spotifyAlbumId ?? null,
      status,
      classification,
      musicBrainz,
      ...(ownLink
        ? { ownWorks: [projectRecordingWork(ownLink.workMbid, index, ownLink.confidence)] }
        : {}),
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

    const state = classification?.state ?? 'unreviewed';
    if (state !== 'classical') {
      addUnresolved(
        spotifyTrackId,
        'unclassified',
        classification,
        [
          gap(HELD_BACK_GAP[state], 'track', spotifyTrackId, classification?.reason ?? null),
          ...contested,
        ],
        known,
      );
      continue;
    }

    if (!anchor && index.ownWorkByTrack.has(spotifyTrackId)) {
      ownTrackHoldings.push(spotifyTrackId);
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

  const projected = [
    ...Array.from(recordingIds).map((recordingMbid) =>
      projectRecording(recordingMbid, heldByRecording.get(recordingMbid) ?? new Set(), index),
    ),
    ...ownTrackHoldings.map((spotifyTrackId) => projectOwnTrack(spotifyTrackId, index)),
  ];
  const recordings = projected.map((entry) => entry.recording);
  for (const { recording, allGaps } of projected) {
    const gapCodes = Array.from(new Set(allGaps.map((item) => item.code)));
    for (const spotifyTrackId of recording.heldTrackIds) {
      accountingByTrack.set(spotifyTrackId, {
        spotifyTrackId,
        status: allGaps.length === 0 ? 'ready' : 'incomplete',
        recordingMbid: recording.source === 'musicbrainz' ? recording.recordingMbid : null,
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

  if (!index.worksByRecording.has(recordingMbid)) {
    pushGap(recordingGaps, gap('recording-work-missing', 'recording', recordingMbid));
  }
  const works = recordingWorks(recordingMbid, index);

  const rawCredits = index.creditsByRecording.get(recordingMbid) ?? [];
  if (rawCredits.length === 0) {
    pushGap(recordingGaps, gap('recording-credits-missing', 'recording', recordingMbid));
  }
  for (const credit of rawCredits) {
    if (!index.artistById.has(credit.artistMbid)) {
      pushGap(
        recordingGaps,
        gap('recording-credit-artist-missing', 'artist', credit.artistMbid, recordingMbid),
      );
    }
  }
  const credits = rawCredits
    .map((credit) => projectCredit(credit, index))
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
      source: 'musicbrainz',
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

/**
 * One Spotify track MusicBrainz has no recording for, held under the work we
 * linked it to. There is no recording to read, so there is no recording
 * title and no performer credit: those stay empty, and the gaps say why.
 */
function projectOwnTrack(
  spotifyTrackId: string,
  index: LibraryIndex,
): { recording: ProjectedRecording; allGaps: MusicBrainzGap[] } {
  const link = index.ownWorkByTrack.get(spotifyTrackId)!;
  const track = index.trackById.get(spotifyTrackId)!;
  const recordingGaps = [gap('recording-unanchored', 'track', spotifyTrackId)];
  const work = projectRecordingWork(link.workMbid, index, link.confidence);
  const occurrence = projectOccurrence(track, new Set([spotifyTrackId]), index, null);
  return {
    allGaps: [...recordingGaps, ...work.gaps, ...occurrence.gaps],
    recording: {
      recordingMbid: `track:${spotifyTrackId}`,
      source: 'track',
      title: null,
      lengthMs: null,
      detail: null,
      heldTrackIds: [spotifyTrackId],
      works: [work],
      credits: [],
      occurrences: [occurrence],
      preferredOccurrence: occurrence,
      gaps: recordingGaps,
    },
  };
}

function projectRecordingWork(
  relatedWorkMbid: string,
  index: LibraryIndex,
  ownLinkConfidence: 'high' | 'medium' | 'low' | null = null,
): ProjectedRecordingWork {
  const gaps: MusicBrainzGap[] = [];
  const linkedBy = ownLinkConfidence ? ('prelude' as const) : ('musicbrainz' as const);
  if (ownLinkConfidence) {
    pushGap(gaps, gap('work-linked-by-us', 'work', relatedWorkMbid, ownLinkConfidence));
  }
  const resolved = resolveDisplayWork(relatedWorkMbid, index.works);
  const { related, level, display } = resolved;
  if (!related || !level) {
    pushGap(gaps, gap('work-cache-missing', 'work', relatedWorkMbid));
    return {
      relatedWorkMbid,
      linkedBy,
      linkConfidence: ownLinkConfidence,
      displayWorkMbid: null,
      workLevelReason: null,
      hierarchy: [],
      parts: [],
      title: null,
      type: null,
      catalogues: [],
      composer: null,
      gaps,
    };
  }

  const stopped = resolved.hierarchyBreak;
  if (stopped?.kind === 'cycle') pushGap(gaps, gap('work-hierarchy-cycle', 'work', stopped.mbid));
  if (stopped?.kind === 'parent-missing') {
    pushGap(
      gaps,
      gap(
        'work-hierarchy-parent-missing',
        'work',
        stopped.parentMbid,
        `child: ${stopped.childMbid}`,
      ),
    );
  }
  for (const work of resolved.hierarchy) {
    if (work.detail === 'stub') pushGap(gaps, gap('work-stub', 'work', work.mbid));
  }
  if (level.needsReview) {
    pushGap(gaps, gap('work-level-ambiguous', 'work', related.mbid, level.reason));
  }
  if (!display) pushGap(gaps, gap('work-cache-missing', 'work', level.mbid));
  const title = display ? nonBlank(display.title) : null;
  const type = display ? nonBlank(display.type) : null;
  if (!title) pushGap(gaps, gap('work-title-missing', 'work', level.mbid));
  if (!type) pushGap(gaps, gap('work-type-missing', 'work', level.mbid));

  // Without climbing to the piece almost every movement would report a
  // missing catalogue and the reader could not group by catalogue number.
  const catalogues = resolved.references.map(
    (catalogue): ProjectedCatalogueReference => ({
      fromWorkMbid: catalogue.workMbid,
      seriesMbid: catalogue.seriesMbid,
      system: catalogue.system,
      number: catalogue.number,
      normalizedSystem: catalogue.normalizedSystem,
      normalizedNumber: catalogue.normalizedNumber,
    }),
  );
  if (catalogues.length === 0) {
    pushGap(gaps, gap('work-catalogue-missing', 'work', level.mbid));
  }

  let composer: ProjectedComposer | null = null;
  if (!resolved.composerMbid) {
    pushGap(gaps, gap('work-composer-missing', 'work', level.mbid));
  } else {
    const artist = index.artistById.get(resolved.composerMbid);
    if (!artist) {
      pushGap(gaps, gap('composer-cache-missing', 'artist', resolved.composerMbid));
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
        pushGap(gaps, gap('composer-name-missing', 'artist', resolved.composerMbid));
      }
    }
  }

  return {
    relatedWorkMbid,
    linkedBy,
    linkConfidence: ownLinkConfidence,
    displayWorkMbid: display?.mbid ?? null,
    workLevelReason: level.reason,
    hierarchy: [...resolved.hierarchy].reverse().map(asNode),
    parts: [...(index.childWorksByParent.get(level.mbid) ?? [])]
      .sort(
        (left, right) =>
          (left.orderingKey ?? Number.MAX_SAFE_INTEGER) -
            (right.orderingKey ?? Number.MAX_SAFE_INTEGER) || left.mbid.localeCompare(right.mbid),
      )
      .map(asNode),
    title,
    type,
    catalogues,
    composer,
    gaps,
  };
}

/**
 * The works a recording is of: MusicBrainz's relations, or our own link
 * where MusicBrainz relates none (the facts should carry one only then).
 */
function recordingWorks(recordingMbid: string, index: LibraryIndex): ProjectedRecordingWork[] {
  const relations = index.worksByRecording.get(recordingMbid) ?? [];
  const ownLink = relations.length === 0 ? index.ownWorkByRecording.get(recordingMbid) : undefined;
  if (ownLink) return [projectRecordingWork(ownLink.workMbid, index, ownLink.confidence)];
  return relations
    .map((relation) => projectRecordingWork(relation.workMbid, index))
    .sort((left, right) => left.relatedWorkMbid.localeCompare(right.relatedWorkMbid));
}

function projectCredit(credit: MbRecordingCreditFact, index: LibraryIndex): ProjectedCredit {
  const artist = index.artistById.get(credit.artistMbid);
  return {
    artistMbid: credit.artistMbid,
    name: artist ? nonBlank(artist.name) : null,
    creditedName: artist ? nonBlank(artist.creditedName) : null,
    role: credit.role,
    instrument: nonBlank(credit.instrument),
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
    works: recordingWorks(recordingMbid, index),
    credits: (index.creditsByRecording.get(recordingMbid) ?? []).map((credit) =>
      projectCredit(credit, index),
    ),
  };
}

function asNode(work: MbWorkFact): ProjectedWorkNode {
  return {
    mbid: work.mbid,
    title: nonBlank(work.title),
    type: nonBlank(work.type),
    orderingKey: work.orderingKey,
    detail: work.detail,
  };
}
