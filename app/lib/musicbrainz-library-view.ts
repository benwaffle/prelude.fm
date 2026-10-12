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

// Recordings are grouped by work and by issue (MusicBrainz release, else Spotify album). Nothing is
// invented: a missing title stays null and a part this issue lacks is listed as missing.

export function playedMovementCount(work: LibraryWork): number {
  return work.movements.filter((movement) => !movement.missing).length;
}

export type RecordingRow = {
  recordingId: string;
  albumId: string;
  album: string;
  cover: string | null;
  year: number | null;
  performer: string | null;
  ensemble: string | null;
  durationMs: number | null;
  duration: string | null;
  // Spotify popularity belongs to a track, not a recording, and nothing aggregates it yet. Unranked
  // is the honest answer.
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

// MusicBrainz's release where we have one, since two Spotify albums can be one release; else the
// Spotify album.
function issueOf(occurrence: ProjectedProviderOccurrence): string {
  return occurrence.releaseMbid ?? `spotify:${occurrence.spotifyAlbumId}`;
}

// The part directly under the card's work: "III. Sequenz" for its "a. Dies irae".
function movementOf(work: ProjectedRecordingWork) {
  const display = work.hierarchy.findIndex((node) => node.mbid === work.displayWorkMbid);
  return (display === -1 ? undefined : work.hierarchy[display + 1]) ?? work.hierarchy.at(-1);
}

function partPosition(work: ProjectedRecordingWork, fallback: number): number {
  return movementOf(work)?.orderingKey ?? fallback;
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

// A reissue or regional edition can be one release on two Spotify albums; list the recording once,
// preferring the liked file.
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

// A part repeating on one issue means two performances, so the card splits into runs of consecutive
// tracks. Two tracks of one part side by side ("Ia", "Ib") stay one performance.
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
      // An opera runs on from one disc to the next.
      const adjacent =
        previous &&
        ((previous.discNumber === member.occurrence.discNumber &&
          member.occurrence.trackNumber - previous.trackNumber <= 1) ||
          (member.occurrence.discNumber === previous.discNumber + 1 &&
            member.occurrence.trackNumber === 1));
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
    // A recording with no work relation is already reported as a gap; an invented card would hide
    // it. A medley appears under each of its works.
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
      ordered.map((member) => movementOf(member.work)?.mbid).filter(Boolean),
    );
    const credits = performingCredits(storedCredits(head.recording));
    const { performer, ensemble } = hasPerformingCredits(credits)
      ? creditLine(credits)
      : { performer: null, ensemble: null };

    // MusicBrainz sometimes relates every movement's recording to the whole work; such a track is
    // named by its own title, no numeral.
    const onWholeWork = (member: CardMember) =>
      member.work.parts.length > 0 && member.work.relatedWorkMbid === member.work.displayWorkMbid;

    const movements: Movement[] = ordered.map((member, index) => {
      const leaf = member.work.hierarchy.at(-1);
      const position = partPosition(member.work, member.occurrence.trackNumber);
      const movement = movementOf(member.work);
      const whole = onWholeWork(member);
      const title = whole
        ? (member.recording.title ?? leaf?.title)
        : (leaf?.title ?? member.recording.title);
      return {
        n: index + 1,
        position,
        roman: whole ? '' : roman(position),
        // Never the Spotify track name, which is a label for the file, not a movement name.
        name: title ?? '',
        unnamed: title == null,
        section: !whole && movement && movement !== leaf ? movement.title : null,
        missing: false,
        durationMs: member.occurrence.durationMs,
        duration: formatDuration(member.occurrence.durationMs),
        liked: likedTrackIds.has(member.occurrence.spotifyTrackId),
        trackId: member.occurrence.spotifyTrackId,
        uri: `spotify:track:${member.occurrence.spotifyTrackId}`,
      };
    });

    // Parts MusicBrainz lists that this issue lacks, shown as ghosts. Unknown when a track is
    // related only to the whole work.
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

// Cards carry the whole album's movements; this narrows back to cards with a liked track, and gaps
// to liked tracks.
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
