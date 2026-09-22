import {
  creditLine,
  hasPerformingCredits,
  performingCredits,
  type StoredCredit,
} from './musicbrainz-credits';
import {
  eraFor,
  formatDuration,
  lifespan,
  shortName,
  tintFor,
  roman,
  type LibraryWork,
  type Movement,
} from './prelude';
import type {
  MusicBrainzGapCode,
  MusicBrainzLibraryProjection,
  ProjectedProviderOccurrence,
  ProjectedRecording,
  ProjectedRecordingWork,
  UnresolvedLibraryTrack,
} from './musicbrainz-library';

/**
 * Turns the MusicBrainz projection into the cards the library screen draws.
 *
 * The projection's unit is a recording — one performance of one work, which
 * for classical music is usually one movement. A card is a work as a
 * listener thinks of it, so the recordings are gathered by the work
 * MusicBrainz says they are parts of, and by the issue carrying them: the
 * MusicBrainz release where we have matched one, the Spotify album where we
 * have not. Two performances of the same work on different releases stay two
 * cards, which is what they are.
 *
 * Nothing here invents a value. A missing title stays null and the card says
 * so; a part of the work that this issue does not carry is listed as
 * missing, because MusicBrainz told us the part exists.
 */

/** Whether a card is the fullest holding of its work, for choosing a default. */
export function playedMovementCount(work: LibraryWork): number {
  return work.movements.filter((movement) => !movement.missing).length;
}

export type MusicBrainzLibrary = {
  works: LibraryWork[];
  /** Every held track that is not on a card, with what is missing. */
  unresolvedTracks: UnresolvedLibraryTrack[];
  accounting: MusicBrainzLibraryProjection['accounting'];
};

type CardMember = {
  recording: ProjectedRecording;
  work: ProjectedRecordingWork;
  occurrence: ProjectedProviderOccurrence;
};

function storedCredits(recording: ProjectedRecording): StoredCredit[] {
  return recording.credits.flatMap((credit) => {
    const name = credit.creditedName ?? credit.name;
    return name
      ? [
          {
            artistMbid: credit.artistMbid,
            name,
            role: credit.role,
            instrument: credit.instrument ?? '',
          },
        ]
      : [];
  });
}

/**
 * The issue a performance was heard on. MusicBrainz's release where we have
 * one, because two Spotify albums can be the same release; otherwise the
 * Spotify album, which is a real thing even when MusicBrainz has no release
 * for it.
 */
function issueOf(occurrence: ProjectedProviderOccurrence): string {
  return occurrence.releaseMbid ?? `spotify:${occurrence.spotifyAlbumId}`;
}

function partPosition(work: ProjectedRecordingWork, fallback: number): number {
  const leaf = work.hierarchy.at(-1);
  return leaf?.orderingKey ?? fallback;
}

export function musicBrainzLibraryView(
  projection: MusicBrainzLibraryProjection,
  likedTrackIds: Set<string>,
  addedAtByTrackId: Map<string, string> = new Map(),
): MusicBrainzLibrary {
  const cards = new Map<string, CardMember[]>();
  for (const recording of projection.recordings) {
    // A recording with no work relation has no work to file it under. It is
    // already reported as a gap; putting it on an invented card would hide
    // that the relation is what is missing.
    for (const work of recording.works) {
      const key = work.displayWorkMbid ?? work.relatedWorkMbid;
      for (const trackId of recording.heldTrackIds) {
        const occurrence = recording.occurrences.find(
          (candidate) => candidate.spotifyTrackId === trackId,
        );
        if (!occurrence) continue;
        const cardKey = `${key}:${issueOf(occurrence)}`;
        cards.set(cardKey, [...(cards.get(cardKey) ?? []), { recording, work, occurrence }]);
      }
    }
  }

  const works: LibraryWork[] = [];
  for (const [cardKey, members] of cards) {
    const ordered = [...members].sort(
      (left, right) =>
        partPosition(left.work, left.occurrence.trackNumber) -
          partPosition(right.work, right.occurrence.trackNumber) ||
        left.occurrence.discNumber - right.occurrence.discNumber ||
        left.occurrence.trackNumber - right.occurrence.trackNumber,
    );
    const head = ordered[0];
    const heldPartMbids = new Set(
      ordered.map((member) => member.work.hierarchy.at(-1)?.mbid).filter(Boolean),
    );
    const credits = performingCredits(storedCredits(head.recording));
    const { performer, ensemble } = hasPerformingCredits(credits)
      ? creditLine(credits)
      : { performer: null, ensemble: null };

    const movements: Movement[] = ordered.map((member, index) => {
      const leaf = member.work.hierarchy.at(-1);
      const position = partPosition(member.work, member.occurrence.trackNumber);
      return {
        n: index + 1,
        position,
        roman: roman(position),
        // The MusicBrainz title of the part, or the recording's own title
        // for a work with no parts. Never the Spotify track name, which is
        // a provider label for the file, not a movement name.
        name: leaf?.title ?? member.recording.title ?? '',
        unnamed: (leaf?.title ?? member.recording.title) === null,
        missing: false,
        durationMs: member.occurrence.durationMs,
        duration: formatDuration(member.occurrence.durationMs),
        liked: likedTrackIds.has(member.occurrence.spotifyTrackId),
        trackId: member.occurrence.spotifyTrackId,
        uri: `spotify:track:${member.occurrence.spotifyTrackId}`,
      };
    });

    // Parts MusicBrainz says the work has and this issue does not carry.
    // Ghosts, so a partial holding reads as partial rather than as a short
    // work — and they come from MusicBrainz, not from a guess at the length.
    for (const part of head.work.parts) {
      if (heldPartMbids.has(part.mbid)) continue;
      const position = part.orderingKey ?? movements.length + 1;
      movements.push({
        n: 0,
        position,
        roman: roman(position),
        name: part.title ?? '',
        unnamed: part.title === null,
        missing: true,
        durationMs: null,
        duration: null,
        liked: false,
        trackId: null,
        uri: null,
      });
    }
    movements.sort((left, right) => left.position - right.position);
    movements.forEach((movement, index) => {
      movement.n = index + 1;
    });

    const gaps = Array.from(
      new Set<MusicBrainzGapCode>(
        ordered.flatMap((member) => [
          ...member.recording.gaps.map((gap) => gap.code),
          ...member.work.gaps.map((gap) => gap.code),
          ...member.occurrence.gaps.map((gap) => gap.code),
        ]),
      ),
    );
    const { tint, ink } = tintFor(head.occurrence.spotifyAlbumId);
    const addedAt = ordered
      .map((member) => addedAtByTrackId.get(member.occurrence.spotifyTrackId))
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);

    works.push({
      id: cardKey,
      workId: head.work.displayWorkMbid ?? head.work.relatedWorkMbid,
      recordingId: head.recording.recordingMbid,
      composer: head.work.composer?.name ? shortName(head.work.composer.name) : null,
      composerFull: head.work.composer?.name ?? null,
      composerId: head.work.composer?.mbid ?? null,
      // MusicBrainz has no artist portrait, and Spotify's is not the
      // composer's unless something has matched the two.
      composerImage: null,
      era: eraFor(head.work.composer?.beginYear ?? null),
      years: lifespan(head.work.composer?.beginYear ?? null, head.work.composer?.endYear ?? null),
      title: head.work.title,
      // A nickname is a MusicBrainz alias we do not read yet.
      nickname: null,
      catalog: head.work.catalogues[0]
        ? `${head.work.catalogues[0].system} ${head.work.catalogues[0].number}`
        : null,
      year: null,
      performer,
      ensemble,
      album: head.occurrence.releaseTitle ?? head.occurrence.providerAlbumTitle ?? '',
      cover: head.occurrence.imageUrl,
      tint,
      ink,
      movements,
      unmatched: false,
      addedAt: addedAt ?? null,
      gaps,
    });
  }

  works.sort(
    (left, right) =>
      (left.composerFull ?? '').localeCompare(right.composerFull ?? '', 'en') ||
      (left.title ?? '').localeCompare(right.title ?? '', 'en') ||
      left.id.localeCompare(right.id),
  );
  return {
    works,
    unresolvedTracks: projection.unresolvedTracks,
    accounting: projection.accounting,
  };
}
