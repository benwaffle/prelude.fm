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

/** A card as one row in a list of recordings of its work. */
export type RecordingRow = {
  recordingId: string;
  albumId: string;
  album: string;
  cover: string | null;
  year: number | null;
  performer: string | null;
  ensemble: string | null;
  /** The movements this issue carries, added up; null when it carries none. */
  durationMs: number | null;
  duration: string | null;
  /**
   * Spotify popularity belongs to a track, not to a MusicBrainz recording,
   * and nothing here has aggregated it yet. Unranked is the honest answer,
   * and the screens already say so.
   */
  popularity: null;
  tint: string;
  unmatched: false;
};

export function recordingRowOf(card: LibraryWork): RecordingRow {
  const played = card.movements.filter((movement) => movement.durationMs !== null);
  const durationMs =
    played.length === 0
      ? null
      : played.reduce((sum, movement) => sum + (movement.durationMs ?? 0), 0);
  return {
    recordingId: card.recordingId ?? card.id,
    albumId: card.albumId ?? card.id,
    album: card.album,
    cover: card.cover,
    year: card.year,
    performer: card.performer,
    ensemble: card.ensemble,
    durationMs,
    duration: durationMs === null ? null : formatDuration(durationMs),
    popularity: null,
    tint: card.tint,
    unmatched: false,
  };
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

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;

function weakestOwnLink(works: ProjectedRecordingWork[]): LibraryWork['ownLink'] {
  let weakest: LibraryWork['ownLink'] = null;
  for (const work of works) {
    const confidence = work.linkedBy === 'prelude' ? work.linkConfidence : null;
    if (confidence && (!weakest || CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[weakest])) {
      weakest = confidence;
    }
  }
  return weakest;
}

/**
 * Two Spotify albums can be one MusicBrainz release — a reissue, a regional
 * edition — and carry the very same recordings. That is one performance
 * heard on two files, so it is listed once, by the liked file where there is
 * one.
 */
function onePerRecording(members: CardMember[], likedTrackIds: Set<string>): CardMember[] {
  const byRecording = new Map<string, CardMember>();
  for (const member of members) {
    const key = `${member.recording.recordingMbid}:${member.work.relatedWorkMbid}`;
    const kept = byRecording.get(key);
    if (
      !kept ||
      (!likedTrackIds.has(kept.occurrence.spotifyTrackId) &&
        likedTrackIds.has(member.occurrence.spotifyTrackId))
    ) {
      byRecording.set(key, member);
    }
  }
  return members.filter(
    (member) =>
      byRecording.get(`${member.recording.recordingMbid}:${member.work.relatedWorkMbid}`) ===
      member,
  );
}

/**
 * An album can carry the same work twice — a compilation with two
 * performances of a concerto, a box with a studio and a live symphony. Those
 * are two performances, not one with every movement doubled. When a part
 * repeats on one issue, the card is split into runs of consecutive tracks,
 * since a performance sits together on the album. Two tracks of one part
 * side by side ("Ia", "Ib") stay one performance.
 */
function separatePerformances(
  cards: Map<string, CardMember[]>,
  likedTrackIds: Set<string>,
): Map<string, CardMember[]> {
  const separated = new Map<string, CardMember[]>();
  for (const [cardKey, all] of cards) {
    const members = onePerRecording(all, likedTrackIds);
    const parts = members.map(
      (member) => member.work.hierarchy.at(-1)?.mbid ?? member.work.relatedWorkMbid,
    );
    if (new Set(parts).size === parts.length) {
      separated.set(cardKey, members);
      continue;
    }
    const byTrack = [...members].sort(
      (left, right) =>
        left.occurrence.discNumber - right.occurrence.discNumber ||
        left.occurrence.trackNumber - right.occurrence.trackNumber,
    );
    let run: CardMember[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const first = run[0].occurrence;
      separated.set(`${cardKey}:${first.discNumber}-${first.trackNumber}`, run);
      run = [];
    };
    for (const member of byTrack) {
      const previous = run.at(-1)?.occurrence;
      const adjacent =
        previous &&
        previous.discNumber === member.occurrence.discNumber &&
        member.occurrence.trackNumber - previous.trackNumber <= 1;
      if (!adjacent) flush();
      run.push(member);
    }
    flush();
  }
  return separated;
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
    //
    // A recording of several works — a medley — appears under each of them.
    // Choosing one would be choosing arbitrarily, and the per-track
    // accounting is unaffected: it counts tracks, not cards.
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
  for (const [cardKey, members] of separatePerformances(cards, likedTrackIds)) {
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

    // MusicBrainz sometimes relates each movement's recording to the whole
    // work rather than to its part. Such a track is some part of the work,
    // but which one MusicBrainz doesn't say, so it is named by its own
    // recording title and carries no movement numeral.
    const onWholeWork = (member: CardMember) =>
      member.work.parts.length > 0 && member.work.relatedWorkMbid === member.work.displayWorkMbid;

    const movements: Movement[] = ordered.map((member, index) => {
      const leaf = member.work.hierarchy.at(-1);
      const position = partPosition(member.work, member.occurrence.trackNumber);
      const whole = onWholeWork(member);
      const title = whole
        ? (member.recording.title ?? leaf?.title)
        : (leaf?.title ?? member.recording.title);
      return {
        n: index + 1,
        position,
        roman: whole ? '' : roman(position),
        // The MusicBrainz title of the part, or the recording's own title
        // for a work with no parts. Never the Spotify track name, which is
        // a provider label for the file, not a movement name.
        name: title ?? '',
        unnamed: title == null,
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
    // When a track is related only to the whole work, the parts it covers
    // are unknown, so no part can be listed as missing on its account.
    const partsKnown = !ordered.some(onWholeWork);
    for (const part of partsKnown ? head.work.parts : []) {
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
      composerImage: head.work.composer?.portrait ?? null,
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
      albumId: head.occurrence.spotifyAlbumId,
      cover: head.occurrence.imageUrl,
      tint,
      ink,
      movements,
      unmatched: false,
      addedAt: addedAt ?? null,
      gaps,
      ownLink: weakestOwnLink(ordered.map((member) => member.work)),
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

/**
 * The library is read together with the rest of each liked track's album, so
 * a card carries every movement the album has rather than only the liked
 * ones — the unliked movements are real tracks, playable, just not hearted.
 * This narrows that read back to the library: cards holding at least one
 * liked track, and the gap list and accounting for liked tracks only, since
 * an album-mate nobody liked is not part of the library.
 */
export function keepLikedHoldings(
  library: MusicBrainzLibrary,
  likedTrackIds: Set<string>,
): MusicBrainzLibrary {
  return {
    works: library.works.filter((work) =>
      work.movements.some((movement) => movement.trackId && likedTrackIds.has(movement.trackId)),
    ),
    unresolvedTracks: library.unresolvedTracks.filter((track) =>
      likedTrackIds.has(track.spotifyTrackId),
    ),
    accounting: library.accounting.filter((track) => likedTrackIds.has(track.spotifyTrackId)),
  };
}
