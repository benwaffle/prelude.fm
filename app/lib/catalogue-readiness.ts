import { classicalEvidenceFor } from './musicbrainz-classical-evidence';
import type { MusicBrainzLibraryProjection, ProjectedRecordingWork } from './musicbrainz-library';
import type {
  MusicBrainzLibraryFacts,
  TrackClassificationState,
} from './musicbrainz-library-facts';
import { diagnoseTracklist } from './musicbrainz-matching';

/**
 * How much of the library the player can actually show, and what stands in
 * the way of the rest.
 *
 * The unit is a Spotify track. The player puts a track on a card when it is
 * classical, linked to a MusicBrainz recording, that recording is linked to
 * a work, and the work the card is filed under names a composer
 * (`projectMusicBrainzLibrary` and `musicBrainzLibraryView`). Those are the
 * steps below, in the order they have to happen: a work cannot be linked to
 * a recording nobody has matched, and MusicBrainz's evidence that a piece is
 * classical lives on the work.
 *
 * Every track lands in exactly one place — ready, excluded as not classical,
 * or blocked at the first step it fails — and every blocked track is filed
 * under the one thing that would move it on. Where nothing here can say what
 * that is, the track is counted as unknown rather than dropped.
 */

export type ReadinessStepKey = 'recording' | 'work' | 'composer' | 'classical';

export type ReadinessBucketKey =
  | 'contested-isrc'
  | 'release-not-looked-up'
  | 'add-release'
  | 'pick-release'
  | 'fix-tracklist'
  | 'release-not-read'
  | 'recording-link-unknown'
  | 'recording-not-read'
  | 'add-work-link'
  | 'work-not-read'
  | 'work-level-unclear'
  | 'add-composer'
  | 'classification-out-of-date'
  | 'add-classical-evidence';

/** The Inbox sections a bucket can send you to. Same ids as the admin URL. */
export type ReadinessInboxClass = 'missing' | 'misaligned' | 'work' | 'contested';

/**
 * `action`: someone has to do something, in the Inbox or on MusicBrainz.
 * `ours`: MusicBrainz may already have it; our cache has not read it yet.
 * `unknown`: nothing here can say what is needed.
 */
export type ReadinessBucketKind = 'action' | 'ours' | 'unknown';

export type ReadinessComposer = 'named' | 'missing' | 'not_read' | 'level_unclear';

export type ReadinessWork = {
  /** The work the player files the track under. */
  workMbid: string;
  title: string | null;
  composer: ReadinessComposer;
};

export type ReadinessTrack = {
  spotifyTrackId: string;
  spotifyAlbumId: string;
  albumTitle: string | null;
  isrc: string | null;
  /** The classification the player uses. */
  classification: TrackClassificationState;
  /** MusicBrainz's current evidence alone would call this classical. */
  musicBrainzSaysClassical: boolean;
  link:
    | { state: 'linked'; recordingMbid: string; recordingTitle: string | null; read: boolean }
    | { state: 'contested' }
    | { state: 'none' };
  release: 'not_checked' | 'missing' | 'ambiguous' | 'matched';
  releaseMbid: string | null;
  /** Only for a matched release; null otherwise. */
  tracklist: 'aligned' | 'misaligned' | 'not_read' | null;
  /** Empty when MusicBrainz links the recording to no work. */
  works: ReadinessWork[];
};

/** Submissions sent (pending or applied) whose effect the cache does not show yet. */
export type ReadinessSubmissions = {
  releaseAlbums: Set<string>;
  tracklistReportAlbums: Set<string>;
  contestedReportIsrcs: Set<string>;
  workLinkRecordings: Set<string>;
};

export const NO_SUBMISSIONS: ReadinessSubmissions = {
  releaseAlbums: new Set(),
  tracklistReportAlbums: new Set(),
  contestedReportIsrcs: new Set(),
  workLinkRecordings: new Set(),
};

export type ReadinessExample = {
  label: string | null;
  href: string;
  tracks: number;
};

export type ReadinessBucket = {
  key: ReadinessBucketKey;
  step: ReadinessStepKey;
  kind: ReadinessBucketKind;
  label: string;
  detail: string;
  inboxClass: ReadinessInboxClass | null;
  tracks: number;
  /** Of `tracks`, those whose fix has been submitted already. */
  waiting: number;
  /** The biggest groups first, so the most useful edit is the first link. */
  examples: ReadinessExample[];
  /** How many distinct groups (albums, recordings, works) the tracks fall into. */
  groups: number;
  groupNoun: ReadinessGroupNoun;
};

export type ReadinessGroupNoun = 'album' | 'recording' | 'work' | 'ISRC';

function groupNounOf(bucket: ReadinessBucketKey): ReadinessGroupNoun {
  if (bucket === 'contested-isrc') return 'ISRC';
  const { step } = BUCKETS[bucket];
  return step === 'recording' ? 'album' : step === 'work' ? 'recording' : 'work';
}

export type ReadinessStep = {
  key: ReadinessStepKey;
  /** What a track that passed this step has. */
  label: string;
  reached: number;
  blocked: number;
  buckets: ReadinessBucket[];
};

export type ReadinessFunnel = {
  total: number;
  notClassical: number;
  inScope: number;
  steps: ReadinessStep[];
  ready: number;
};

const STEPS: { key: ReadinessStepKey; label: string }[] = [
  { key: 'recording', label: 'Linked to a MusicBrainz recording' },
  { key: 'work', label: 'Recording linked to a work' },
  { key: 'composer', label: 'Work has a composer' },
  { key: 'classical', label: 'Recognised as classical' },
];

type BucketSpec = {
  step: ReadinessStepKey;
  kind: ReadinessBucketKind;
  label: string;
  detail: string;
  inboxClass: ReadinessInboxClass | null;
};

const BUCKETS: Record<ReadinessBucketKey, BucketSpec> = {
  'contested-isrc': {
    step: 'recording',
    kind: 'action',
    label: 'Report an ISRC that MusicBrainz gives to several recordings',
    detail: "The track's ISRC names more than one recording, so it cannot be linked to either.",
    inboxClass: 'contested',
  },
  'add-release': {
    step: 'recording',
    kind: 'action',
    label: 'Add the missing release (Harmony)',
    detail: 'MusicBrainz has no release with this album’s barcode.',
    inboxClass: 'missing',
  },
  'pick-release': {
    step: 'recording',
    kind: 'action',
    label: 'Pick the right release — several share the barcode',
    detail: 'More than one MusicBrainz release carries this barcode, so none was chosen.',
    inboxClass: 'missing',
  },
  'fix-tracklist': {
    step: 'recording',
    kind: 'action',
    label: 'Resolve a tracklist that does not line up',
    detail: 'MusicBrainz has the release, but its tracks do not match the Spotify album.',
    inboxClass: 'misaligned',
  },
  'release-not-looked-up': {
    step: 'recording',
    kind: 'ours',
    label: 'Album not looked up in MusicBrainz yet',
    detail: 'No edit to make yet: our pipeline has not searched for this barcode.',
    inboxClass: null,
  },
  'release-not-read': {
    step: 'recording',
    kind: 'ours',
    label: 'Release found but its tracklist not read yet',
    detail: 'No edit to make yet: our cache has not read the release’s tracks.',
    inboxClass: null,
  },
  'recording-link-unknown': {
    step: 'recording',
    kind: 'unknown',
    label: 'Unknown — release lines up but the track is not linked',
    detail: 'The album and release agree, yet no recording is linked. Needs investigation.',
    inboxClass: null,
  },
  'add-work-link': {
    step: 'work',
    kind: 'action',
    label: 'Link the recording to its work',
    detail: 'MusicBrainz has the recording but does not say what work it performs.',
    inboxClass: 'work',
  },
  'recording-not-read': {
    step: 'work',
    kind: 'ours',
    label: 'Recording not fully read yet',
    detail: 'No edit to make yet: MusicBrainz may already link it to a work.',
    inboxClass: null,
  },
  'add-composer': {
    step: 'composer',
    kind: 'action',
    label: 'Add a composer to the work',
    detail: 'The work the player files this under has no composer in MusicBrainz.',
    inboxClass: null,
  },
  'work-level-unclear': {
    step: 'composer',
    kind: 'unknown',
    label: 'Unknown — unclear which work this is a part of',
    detail:
      'The work has a parent but is titled differently and has no type, so the player cannot tell a movement from a piece in a collection. It has no composer of its own.',
    inboxClass: null,
  },
  'work-not-read': {
    step: 'composer',
    kind: 'ours',
    label: 'Work or composer not read yet',
    detail: 'No edit to make yet: our cache has only the work’s name, or not the composer’s.',
    inboxClass: null,
  },
  'add-classical-evidence': {
    step: 'classical',
    kind: 'action',
    label: 'Give the work a catalogue number or a classical work type',
    detail:
      'MusicBrainz gives the work neither, which is the only evidence the app accepts. If the piece is not classical, it is correctly held back.',
    inboxClass: null,
  },
  'classification-out-of-date': {
    step: 'classical',
    kind: 'ours',
    label: 'Our classification is out of date',
    detail: 'No edit to make: MusicBrainz now has the evidence; the stored decision predates it.',
    inboxClass: null,
  },
};

type Placement = {
  bucket: ReadinessBucketKey;
  waiting: boolean;
  group: { id: string; label: string | null; href: string };
};

function albumGroup(track: ReadinessTrack): Placement['group'] {
  return {
    id: `album:${track.spotifyAlbumId}`,
    label: track.albumTitle,
    href: `https://open.spotify.com/album/${track.spotifyAlbumId}`,
  };
}

function workGroup(work: ReadinessWork): Placement['group'] {
  return {
    id: `work:${work.workMbid}`,
    label: work.title,
    href: `https://musicbrainz.org/work/${work.workMbid}`,
  };
}

/** Which bucket a track that is not ready belongs in, or null if it is ready. */
export function placeTrack(
  track: ReadinessTrack,
  submissions: ReadinessSubmissions = NO_SUBMISSIONS,
): Placement | null {
  if (track.link.state === 'contested') {
    return {
      bucket: 'contested-isrc',
      waiting: track.isrc !== null && submissions.contestedReportIsrcs.has(track.isrc),
      group: {
        id: `isrc:${track.isrc ?? track.spotifyTrackId}`,
        label: track.isrc,
        href: `https://musicbrainz.org/isrc/${track.isrc ?? ''}`,
      },
    };
  }
  if (track.link.state === 'none') {
    const group = albumGroup(track);
    switch (track.release) {
      case 'not_checked':
        return { bucket: 'release-not-looked-up', waiting: false, group };
      case 'missing':
        return {
          bucket: 'add-release',
          waiting: submissions.releaseAlbums.has(track.spotifyAlbumId),
          group,
        };
      case 'ambiguous':
        return { bucket: 'pick-release', waiting: false, group };
      case 'matched':
        if (track.tracklist === 'misaligned') {
          return {
            bucket: 'fix-tracklist',
            waiting: submissions.tracklistReportAlbums.has(track.spotifyAlbumId),
            group,
          };
        }
        if (track.tracklist === 'not_read' || track.tracklist === null) {
          return { bucket: 'release-not-read', waiting: false, group };
        }
        return { bucket: 'recording-link-unknown', waiting: false, group };
    }
  }

  const { recordingMbid, recordingTitle, read } = track.link;
  if (track.works.length === 0) {
    const group = {
      id: `recording:${recordingMbid}`,
      label: recordingTitle,
      href: `https://musicbrainz.org/recording/${recordingMbid}`,
    };
    return read
      ? {
          bucket: 'add-work-link',
          waiting: submissions.workLinkRecordings.has(recordingMbid),
          group,
        }
      : { bucket: 'recording-not-read', waiting: false, group };
  }

  // A recording of several works appears under each; every card needs its
  // composer. The first unnamed one decides, in the order the fix is surest.
  const unnamed = track.works.filter((work) => work.composer !== 'named');
  const blocking =
    unnamed.find((work) => work.composer === 'missing') ??
    unnamed.find((work) => work.composer === 'level_unclear') ??
    unnamed[0];
  if (blocking) {
    const bucket: ReadinessBucketKey =
      blocking.composer === 'missing'
        ? 'add-composer'
        : blocking.composer === 'level_unclear'
          ? 'work-level-unclear'
          : 'work-not-read';
    return { bucket, waiting: false, group: workGroup(blocking) };
  }

  if (track.classification !== 'classical') {
    return {
      bucket: track.musicBrainzSaysClassical
        ? 'classification-out-of-date'
        : 'add-classical-evidence',
      waiting: false,
      group: workGroup(track.works[0]),
    };
  }
  return null;
}

const EXAMPLES = 5;

export function readinessFunnel(
  tracks: ReadinessTrack[],
  submissions: ReadinessSubmissions = NO_SUBMISSIONS,
): ReadinessFunnel {
  let notClassical = 0;
  let ready = 0;
  const placed = new Map<
    ReadinessBucketKey,
    { tracks: number; waiting: number; groups: Map<string, ReadinessExample> }
  >();

  for (const track of tracks) {
    // Not classical needs no work. Counted, not dropped.
    if (track.classification === 'not_classical') {
      notClassical++;
      continue;
    }
    const placement = placeTrack(track, submissions);
    if (!placement) {
      ready++;
      continue;
    }
    const entry = placed.get(placement.bucket) ?? { tracks: 0, waiting: 0, groups: new Map() };
    entry.tracks++;
    if (placement.waiting) entry.waiting++;
    const group = entry.groups.get(placement.group.id) ?? {
      label: placement.group.label,
      href: placement.group.href,
      tracks: 0,
    };
    group.tracks++;
    entry.groups.set(placement.group.id, group);
    placed.set(placement.bucket, entry);
  }

  const inScope = tracks.length - notClassical;
  let reached = inScope;
  const steps = STEPS.map(({ key, label }): ReadinessStep => {
    const buckets = (Object.keys(BUCKETS) as ReadinessBucketKey[])
      .filter((bucket) => BUCKETS[bucket].step === key && placed.has(bucket))
      .map((bucket): ReadinessBucket => {
        const entry = placed.get(bucket)!;
        const groups = [...entry.groups.values()].sort(
          (left, right) =>
            right.tracks - left.tracks || (left.label ?? '').localeCompare(right.label ?? ''),
        );
        return {
          key: bucket,
          ...BUCKETS[bucket],
          tracks: entry.tracks,
          waiting: entry.waiting,
          examples: groups.slice(0, EXAMPLES),
          groups: groups.length,
          groupNoun: groupNounOf(bucket),
        };
      })
      .sort((left, right) => right.tracks - left.tracks || left.key.localeCompare(right.key));
    const blocked = buckets.reduce((sum, bucket) => sum + bucket.tracks, 0);
    reached -= blocked;
    return { key, label, reached, blocked, buckets };
  });

  return { total: tracks.length, notClassical, inScope, steps, ready };
}

/**
 * The composer a card would show for this work, read the way the player
 * reads it: from the work `workLevelOf` files the track under.
 */
export function composerState(work: ProjectedRecordingWork): ReadinessComposer {
  if (work.composer?.name) return 'named';
  const notRead = work.gaps.some(
    (gap) =>
      gap.code === 'work-cache-missing' ||
      gap.code === 'work-hierarchy-parent-missing' ||
      gap.code === 'composer-cache-missing' ||
      gap.code === 'composer-name-missing' ||
      (gap.code === 'work-stub' &&
        (gap.entityId === work.displayWorkMbid || gap.entityId === work.relatedWorkMbid)),
  );
  if (notRead || work.displayWorkMbid === null) return 'not_read';
  if (work.workLevelReason === 'unresolved') return 'level_unclear';
  return 'missing';
}

/**
 * Reads readiness rows out of the facts the player loads and the projection
 * it draws from, so the two cannot disagree about what a track needs.
 */
export function readinessTracksFrom(
  facts: MusicBrainzLibraryFacts,
  projection: MusicBrainzLibraryProjection,
  isrcByTrack: Map<string, string | null> = new Map(),
): ReadinessTrack[] {
  const trackById = new Map(facts.providerTracks.map((track) => [track.spotifyTrackId, track]));
  const albumById = new Map(facts.providerAlbums.map((album) => [album.spotifyAlbumId, album]));
  const classificationByTrack = new Map(
    facts.classifications.map((classification) => [
      classification.spotifyTrackId,
      classification.state,
    ]),
  );
  const anchorByTrack = new Map(facts.anchors.map((anchor) => [anchor.spotifyTrackId, anchor]));
  const recordingById = new Map(facts.mbRecordings.map((recording) => [recording.mbid, recording]));
  const workMbidsByRecording = new Map<string, string[]>();
  for (const relation of facts.mbRecordingWorks) {
    workMbidsByRecording.set(relation.recordingMbid, [
      ...(workMbidsByRecording.get(relation.recordingMbid) ?? []),
      relation.workMbid,
    ]);
  }
  const workByMbid = new Map(facts.mbWorks.map((work) => [work.mbid, work]));
  const catalogued = new Set(facts.mbWorkCatalogues.map((catalogue) => catalogue.workMbid));

  const worksByTrack = new Map<string, ProjectedRecordingWork[]>();
  for (const recording of projection.recordings) {
    for (const trackId of recording.heldTrackIds) worksByTrack.set(trackId, recording.works);
  }
  for (const unresolved of projection.unresolvedTracks) {
    if (unresolved.musicBrainz) {
      worksByTrack.set(unresolved.spotifyTrackId, unresolved.musicBrainz.works);
    }
  }

  const tracksByAlbum = new Map<string, typeof facts.providerTracks>();
  for (const track of facts.providerTracks) {
    tracksByAlbum.set(track.spotifyAlbumId, [
      ...(tracksByAlbum.get(track.spotifyAlbumId) ?? []),
      track,
    ]);
  }
  const releaseTracksByRelease = new Map<string, typeof facts.mbReleaseTracks>();
  for (const track of facts.mbReleaseTracks) {
    releaseTracksByRelease.set(track.releaseMbid, [
      ...(releaseTracksByRelease.get(track.releaseMbid) ?? []),
      track,
    ]);
  }
  const tracklistByAlbum = new Map<string, 'aligned' | 'misaligned' | 'not_read'>();
  const tracklistOf = (albumId: string, releaseMbid: string) => {
    const known = tracklistByAlbum.get(albumId);
    if (known) return known;
    const theirs = releaseTracksByRelease.get(releaseMbid) ?? [];
    const state =
      theirs.length === 0
        ? 'not_read'
        : diagnoseTracklist(
              (tracksByAlbum.get(albumId) ?? []).map((track) => ({
                discNumber: track.discNumber,
                trackNumber: track.trackNumber,
                durationMs: track.durationMs,
              })),
              theirs.map((track) => ({
                medium: track.medium,
                position: track.position,
                length: track.lengthMs,
              })),
            ).kind === 'aligned'
          ? 'aligned'
          : 'misaligned';
    tracklistByAlbum.set(albumId, state);
    return state;
  };

  return facts.requestedTrackIds.flatMap((spotifyTrackId): ReadinessTrack[] => {
    const track = trackById.get(spotifyTrackId);
    if (!track) return [];
    const album = albumById.get(track.spotifyAlbumId);
    const resolution = album?.releaseResolution ?? { state: 'not_checked' as const };
    const releaseMbid =
      resolution.state === 'matched' || resolution.state === 'misaligned'
        ? resolution.releaseMbid
        : null;
    const anchor = anchorByTrack.get(spotifyTrackId);
    const recording =
      anchor?.state === 'accepted' ? recordingById.get(anchor.recordingMbid) : undefined;
    const evidenceWorks =
      anchor?.state === 'accepted' ? (workMbidsByRecording.get(anchor.recordingMbid) ?? []) : [];

    return [
      {
        spotifyTrackId,
        spotifyAlbumId: track.spotifyAlbumId,
        albumTitle: album?.title ?? null,
        isrc: isrcByTrack.get(spotifyTrackId) ?? null,
        classification: classificationByTrack.get(spotifyTrackId) ?? 'unreviewed',
        musicBrainzSaysClassical:
          classicalEvidenceFor(evidenceWorks, workByMbid, catalogued).state === 'classical',
        link:
          anchor?.state === 'accepted'
            ? {
                state: 'linked',
                recordingMbid: anchor.recordingMbid,
                recordingTitle: recording?.title ?? null,
                read: recording?.detail === 'full',
              }
            : anchor?.state === 'conflicting'
              ? { state: 'contested' }
              : { state: 'none' },
        release: resolution.state === 'misaligned' ? 'matched' : resolution.state,
        releaseMbid,
        tracklist: releaseMbid ? tracklistOf(track.spotifyAlbumId, releaseMbid) : null,
        works: (anchor?.state === 'accepted' ? (worksByTrack.get(spotifyTrackId) ?? []) : []).map(
          (work) => ({
            workMbid: work.displayWorkMbid ?? work.relatedWorkMbid,
            title: work.title,
            composer: composerState(work),
          }),
        ),
      },
    ];
  });
}
