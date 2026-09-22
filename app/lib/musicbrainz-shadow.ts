import { normalizeMetadataText } from './classical-normalization';
import type { LibraryWork } from './prelude';
import type { MusicBrainzLibraryProjection, MusicBrainzGapCode } from './musicbrainz-library';

/**
 * Compares the reader we have with the reader we are replacing, over the same
 * liked track IDs, and says exactly where they differ.
 *
 * This renders nothing and writes nothing. It exists so the cutover is a
 * decision made against measurements rather than a leap: the gate that
 * matters is that no track the current reader shows disappears from the new
 * one, and that every liked ID is accounted for either as ready or as a
 * named gap. A difference in title or composer is not automatically a fault
 * — the MusicBrainz value is the authority — but an unexplained one is worth
 * looking at before the switch.
 */

export type ShadowDifferenceCode =
  /** The projection did not mention a requested ID at all. Always a fault. */
  | 'unaccounted'
  /** The current reader shows this track; the new one does not hold it. */
  | 'dropped-from-library'
  /** The new reader holds a track the current one never showed. */
  | 'newly-held'
  /** One legacy work+recording spans several MusicBrainz recordings. */
  | 'group-split'
  /** Several legacy work+recordings collapse into one MusicBrainz recording. */
  | 'group-merged'
  | 'work-title-differs'
  | 'composer-differs'
  | 'catalogue-differs';

export type ShadowDifference = {
  code: ShadowDifferenceCode;
  spotifyTrackIds: string[];
  /** What the reader in production says today, where it says anything. */
  legacy: string | null;
  /** What the MusicBrainz projection says. */
  musicBrainz: string | null;
  /** Why the new reader cannot show it, when that is the difference. */
  gapCodes: MusicBrainzGapCode[];
};

export type ShadowComparison = {
  requestedTrackCount: number;
  /** Held by the MusicBrainz reader, ready or with gaps. */
  musicBrainzHeldCount: number;
  /** Shown by the reader in production today. */
  legacyHeldCount: number;
  readyCount: number;
  incompleteCount: number;
  gapBucketCount: number;
  /**
   * MusicBrainz recordings whose provider occurrences span more than one
   * Spotify album — the duplicate issues the current reader shows twice.
   */
  coalescedDuplicateReleaseCount: number;
  /** Counts by code, so a run can be compared with the one before it. */
  differenceCounts: Record<ShadowDifferenceCode, number>;
  differences: ShadowDifference[];
  /** The cutover gates, each true only when its difference class is empty. */
  gates: {
    everyRequestedTrackAccountedFor: boolean;
    noTrackDisappears: boolean;
  };
};

function sameText(left: string | null, right: string | null): boolean {
  if (!left || !right) return !left && !right;
  return normalizeMetadataText(left) === normalizeMetadataText(right);
}

function catalogueLabelOf(
  work: MusicBrainzLibraryProjection['recordings'][number]['works'][number] | undefined,
): string | null {
  const reference = work?.catalogues[0];
  return reference ? `${reference.system} ${reference.number}` : null;
}

export function compareLibraryProjections(
  legacyWorks: LibraryWork[],
  projection: MusicBrainzLibraryProjection,
): ShadowComparison {
  const requested = new Set(projection.requestedTrackIds);
  const differences: ShadowDifference[] = [];

  const legacyByTrackId = new Map<string, LibraryWork>();
  const legacyGroupByTrackId = new Map<string, string>();
  for (const work of legacyWorks) {
    for (const movement of work.movements) {
      // A ghost row is a movement the recording does not carry; it is not a
      // track the reader is showing the user as held.
      if (!movement.trackId || movement.missing || !movement.liked) continue;
      if (!requested.has(movement.trackId)) continue;
      legacyByTrackId.set(movement.trackId, work);
      legacyGroupByTrackId.set(movement.trackId, work.id);
    }
  }

  const mbRecordingByTrackId = new Map<string, string>();
  const mbWorkByTrackId = new Map<
    string,
    MusicBrainzLibraryProjection['recordings'][number]['works'][number] | undefined
  >();
  for (const recording of projection.recordings) {
    for (const trackId of recording.heldTrackIds) {
      mbRecordingByTrackId.set(trackId, recording.recordingMbid);
      mbWorkByTrackId.set(trackId, recording.works[0]);
    }
  }

  const gapCodesByTrackId = new Map(
    projection.accounting.map((track) => [track.spotifyTrackId, track.gapCodes]),
  );
  const accountedTrackIds = new Set(projection.accounting.map((track) => track.spotifyTrackId));

  for (const spotifyTrackId of projection.requestedTrackIds) {
    if (accountedTrackIds.has(spotifyTrackId)) continue;
    differences.push({
      code: 'unaccounted',
      spotifyTrackIds: [spotifyTrackId],
      legacy: null,
      musicBrainz: null,
      gapCodes: [],
    });
  }

  for (const [spotifyTrackId, legacyWork] of legacyByTrackId) {
    if (mbRecordingByTrackId.has(spotifyTrackId)) continue;
    differences.push({
      code: 'dropped-from-library',
      spotifyTrackIds: [spotifyTrackId],
      legacy: `${legacyWork.composer} — ${legacyWork.title}`,
      musicBrainz: null,
      gapCodes: gapCodesByTrackId.get(spotifyTrackId) ?? [],
    });
  }

  for (const [spotifyTrackId, recordingMbid] of mbRecordingByTrackId) {
    if (legacyByTrackId.has(spotifyTrackId)) continue;
    differences.push({
      code: 'newly-held',
      spotifyTrackIds: [spotifyTrackId],
      legacy: null,
      musicBrainz: recordingMbid,
      gapCodes: gapCodesByTrackId.get(spotifyTrackId) ?? [],
    });
  }

  // Grouping, both directions. A split loses the programme order the reader
  // depends on; a merge is usually the duplicate-release fix working, and is
  // reported so it can be confirmed rather than assumed.
  const mbRecordingsByLegacyGroup = new Map<string, Set<string>>();
  const legacyGroupsByMbRecording = new Map<string, Set<string>>();
  for (const [spotifyTrackId, legacyGroup] of legacyGroupByTrackId) {
    const recordingMbid = mbRecordingByTrackId.get(spotifyTrackId);
    if (!recordingMbid) continue;
    const forward = mbRecordingsByLegacyGroup.get(legacyGroup) ?? new Set();
    forward.add(recordingMbid);
    mbRecordingsByLegacyGroup.set(legacyGroup, forward);
    const backward = legacyGroupsByMbRecording.get(recordingMbid) ?? new Set();
    backward.add(legacyGroup);
    legacyGroupsByMbRecording.set(recordingMbid, backward);
  }
  for (const [legacyGroup, recordingMbids] of mbRecordingsByLegacyGroup) {
    if (recordingMbids.size < 2) continue;
    differences.push({
      code: 'group-split',
      spotifyTrackIds: [...legacyGroupByTrackId]
        .filter(([, group]) => group === legacyGroup)
        .map(([trackId]) => trackId)
        .sort(),
      legacy: legacyGroup,
      musicBrainz: [...recordingMbids].sort().join(', '),
      gapCodes: [],
    });
  }
  for (const [recordingMbid, legacyGroups] of legacyGroupsByMbRecording) {
    if (legacyGroups.size < 2) continue;
    differences.push({
      code: 'group-merged',
      spotifyTrackIds: [...legacyGroupByTrackId]
        .filter(([, group]) => legacyGroups.has(group))
        .map(([trackId]) => trackId)
        .sort(),
      legacy: [...legacyGroups].sort().join(', '),
      musicBrainz: recordingMbid,
      gapCodes: [],
    });
  }

  for (const [spotifyTrackId, legacyWork] of legacyByTrackId) {
    const mbWork = mbWorkByTrackId.get(spotifyTrackId);
    if (!mbRecordingByTrackId.has(spotifyTrackId)) continue;
    const comparisons: Array<[ShadowDifferenceCode, string | null, string | null]> = [
      ['work-title-differs', legacyWork.title, mbWork?.title ?? null],
      ['composer-differs', legacyWork.composerFull, mbWork?.composer?.name ?? null],
      ['catalogue-differs', legacyWork.catalog, catalogueLabelOf(mbWork)],
    ];
    for (const [code, legacy, musicBrainz] of comparisons) {
      if (sameText(legacy, musicBrainz)) continue;
      differences.push({
        code,
        spotifyTrackIds: [spotifyTrackId],
        legacy,
        musicBrainz,
        gapCodes: gapCodesByTrackId.get(spotifyTrackId) ?? [],
      });
    }
  }

  const differenceCounts = differences.reduce(
    (counts, difference) => ({
      ...counts,
      [difference.code]: counts[difference.code] + 1,
    }),
    {
      unaccounted: 0,
      'dropped-from-library': 0,
      'newly-held': 0,
      'group-split': 0,
      'group-merged': 0,
      'work-title-differs': 0,
      'composer-differs': 0,
      'catalogue-differs': 0,
    } as Record<ShadowDifferenceCode, number>,
  );

  return {
    requestedTrackCount: projection.requestedTrackIds.length,
    musicBrainzHeldCount: mbRecordingByTrackId.size,
    legacyHeldCount: legacyByTrackId.size,
    readyCount: projection.accounting.filter((track) => track.status === 'ready').length,
    incompleteCount: projection.accounting.filter((track) => track.status === 'incomplete').length,
    gapBucketCount: projection.unresolvedTracks.length,
    coalescedDuplicateReleaseCount: projection.recordings.filter(
      (recording) =>
        new Set(recording.occurrences.map((occurrence) => occurrence.spotifyAlbumId)).size > 1,
    ).length,
    differenceCounts,
    differences,
    gates: {
      everyRequestedTrackAccountedFor: differenceCounts.unaccounted === 0,
      noTrackDisappears: differenceCounts['dropped-from-library'] === 0,
    },
  };
}
