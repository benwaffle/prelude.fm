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
  programmeMovementName,
  shortName,
  tintFor,
  roman,
  type LibraryWork,
  type Movement,
} from './prelude';
import type {
  AlbumTrack,
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

// The parts between that one and the track's own: "a. Dies irae" under "III. Sequenz".
function partsBeneathMovement(work: ProjectedRecordingWork) {
  const display = work.hierarchy.findIndex((node) => node.mbid === work.displayWorkMbid);
  return display === -1 ? [] : work.hierarchy.slice(display + 2);
}

const orderOf = (node: { orderingKey: number | null }) =>
  node.orderingKey ?? Number.MAX_SAFE_INTEGER;

function byPlaceInWork(left: number[], right: number[]): number {
  for (let level = 0; level < Math.max(left.length, right.length); level++) {
    const difference = (left[level] ?? -1) - (right[level] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
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
    // Tracks filed under a whole act are each a piece of it, not repeats of it.
    const sections = new Set(all[0].work.parts.map((part) => part.parentMbid));
    const parts = members
      .map((member) => member.work.hierarchy.at(-1)?.mbid ?? member.work.relatedWorkMbid)
      .filter((part) => !sections.has(part));
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

// One track can play several parts ("I. Largo – II. Fantasmi"): MusicBrainz relates its recording
// to each. That is one row, or the card shows the same track twice and plays both at once.
function joinPartsOfOneTrack(movements: Movement[]) {
  const partsOfTrack = new Map<string, Movement[]>();
  for (const movement of movements) {
    if (!movement.trackId) continue;
    partsOfTrack.set(movement.trackId, [...(partsOfTrack.get(movement.trackId) ?? []), movement]);
  }
  for (const parts of partsOfTrack.values()) {
    if (parts.length === 1) continue;
    const [row, ...rest] = parts;
    const numerals = parts.map((part) => part.roman).filter(Boolean);
    const consecutive = parts.every(
      (part, index) => index === 0 || part.position === parts[index - 1].position + 1,
    );
    row.roman =
      consecutive && numerals.length === parts.length
        ? `${numerals[0]}–${numerals.at(-1)}`
        : numerals.join(', ');
    row.name = parts
      .map((part) => part.name)
      .filter(Boolean)
      .join(' – ');
    row.unnamed = parts.some((part) => part.unnamed);
    for (const part of rest) movements.splice(movements.indexOf(part), 1);
  }
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

  const performances = separatePerformances(cards, likedTrackIds);
  const { folded, albumTracks } = foldIntoWorkCards(performances, projection.albumTracks);

  const works: LibraryWork[] = [];
  for (const [cardKey, members] of performances) {
    const { catalogue: foldedBy = null, tracks: unlinked = [] } = folded.get(cardKey) ?? {};
    const ordered = [...members].sort(
      (left, right) =>
        partPosition(left.work, left.occurrence.trackNumber) -
          partPosition(right.work, right.occurrence.trackNumber) ||
        left.occurrence.discNumber - right.occurrence.discNumber ||
        left.occurrence.trackNumber - right.occurrence.trackNumber,
    );
    const head = ordered[0];
    const credits = performingCredits(storedCredits(head.recording));
    const { performer, ensemble } = hasPerformingCredits(credits)
      ? creditLine(credits)
      : { performer: null, ensemble: null };

    // MusicBrainz sometimes relates every movement's recording to the whole work; such a track is
    // named by its own title, no numeral.
    const onWholeWork = (member: CardMember) =>
      member.work.parts.length > 0 && member.work.relatedWorkMbid === member.work.displayWorkMbid;

    // Where each row sits in the work: its movement's position, then its place in each section.
    const placeInWork = new Map<Movement, number[]>();
    const movements: Movement[] = ordered.map((member, index) => {
      const leaf = member.work.hierarchy.at(-1);
      const position = partPosition(member.work, member.occurrence.trackNumber);
      const movement = movementOf(member.work);
      const whole = onWholeWork(member);
      const title = whole
        ? (member.recording.title ?? leaf?.title)
        : (leaf?.title ?? member.recording.title);
      // Only MusicBrainz's own order numbers a part; a track number would be our invention.
      const numeral = whole || movement?.orderingKey == null ? '' : roman(position);
      // "Sequenz" for the part under the work, so a sub-part can be named within it.
      const section =
        !whole && movement && movement !== leaf && movement.title
          ? programmeMovementName(movement.title, head.work.title, numeral)
          : null;
      const row: Movement = {
        n: index + 1,
        position,
        roman: numeral,
        // Never the Spotify track name, which is a label for the file, not a movement name. Named
        // within the card's work: "Introitus", not "Requiem in D minor, K. 626: I. Introitus".
        name: title ? programmeMovementName(title, head.work.title, numeral) : '',
        unnamed: title == null,
        section,
        missing: false,
        durationMs: member.occurrence.durationMs,
        duration: formatDuration(member.occurrence.durationMs),
        liked: likedTrackIds.has(member.occurrence.spotifyTrackId),
        trackId: member.occurrence.spotifyTrackId,
        uri: `spotify:track:${member.occurrence.spotifyTrackId}`,
      };
      placeInWork.set(
        row,
        unlinked.length > 0
          ? albumPlace(member.occurrence)
          : [position, ...partsBeneathMovement(member.work).map(orderOf)],
      );
      return row;
    });
    for (const track of unlinked) {
      const row: Movement = {
        n: 0,
        position: 0,
        roman: '',
        name: trackNameWithin(track.occurrence.providerTitle, foldedBy),
        unnamed: true,
        section: null,
        missing: false,
        durationMs: track.occurrence.durationMs,
        duration: formatDuration(track.occurrence.durationMs),
        liked: likedTrackIds.has(track.occurrence.spotifyTrackId),
        trackId: track.occurrence.spotifyTrackId,
        uri: `spotify:track:${track.occurrence.spotifyTrackId}`,
      };
      placeInWork.set(row, albumPlace(track.occurrence));
      movements.push(row);
    }

    // Parts MusicBrainz lists that this issue lacks, at every level, shown as ghosts. Unknown
    // under a work or section a track is related to as a whole.
    const held = new Set(
      ordered.flatMap((member) => member.work.hierarchy.map((node) => node.mbid)),
    );
    const relatedWhole = new Set(ordered.map((member) => member.work.relatedWorkMbid));
    const partByMbid = new Map(head.work.parts.map((part) => [part.mbid, part]));
    const unorderedPosition = new Map<string, number>();
    // Any unlinked track could be one of them, so none is claimed missing.
    for (const part of unlinked.length > 0 ? [] : head.work.parts) {
      const chain = [part];
      while (partByMbid.has(chain[0].parentMbid))
        chain.unshift(partByMbid.get(chain[0].parentMbid)!);
      if (held.has(part.mbid) || chain.some((node) => relatedWhole.has(node.parentMbid))) continue;
      const [movement] = chain;
      const position =
        movement.orderingKey ??
        unorderedPosition.get(movement.mbid) ??
        unorderedPosition.set(movement.mbid, movements.length + 1).get(movement.mbid)!;
      const numeral = movement.orderingKey == null ? '' : roman(position);
      const row: Movement = {
        n: 0,
        position,
        roman: numeral,
        name: part.title ? programmeMovementName(part.title, head.work.title, numeral) : '',
        unnamed: part.title === null,
        section:
          movement !== part && movement.title
            ? programmeMovementName(movement.title, head.work.title, numeral)
            : null,
        missing: true,
        durationMs: null,
        duration: null,
        liked: false,
        trackId: null,
        uri: null,
      };
      placeInWork.set(row, [position, ...chain.slice(1).map(orderOf)]);
      movements.push(row);
    }
    movements.sort((left, right) => byPlaceInWork(placeInWork.get(left)!, placeInWork.get(right)!));
    joinPartsOfOneTrack(movements);
    movements.forEach((movement, index) => {
      movement.n = index + 1;
    });

    const gaps = Array.from(
      new Set<MusicBrainzGapCode>([
        ...ordered.flatMap((member) => [
          ...member.recording.gaps.map((gap) => gap.code),
          ...member.work.gaps.map((gap) => gap.code),
          ...member.occurrence.gaps.map((gap) => gap.code),
        ]),
        ...unlinked.flatMap((track) => track.gaps.map((gap) => gap.code)),
      ]),
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
      catalog: cardCatalogue(head.work),
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

  works.push(...albumCards(albumTracks, likedTrackIds, addedAtByTrackId));

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

function cardCatalogue(work: ProjectedRecordingWork): string | null {
  return work.catalogues[0] ? `${work.catalogues[0].system} ${work.catalogues[0].number}` : null;
}

const albumPlace = (occurrence: ProjectedProviderOccurrence) => [
  occurrence.discNumber,
  occurrence.trackNumber,
];

// Where a catalogue number stands in a title as a whole token: "HWV 46a" in "…, HWV 46a, Pt. 1: …",
// not in "HWV 46". Spaces are ignored, since Spotify and MusicBrainz space them differently.
function catalogueEnd(title: string, catalogue: string): number | null {
  const wanted = catalogue.replace(/\s+/g, '').toLowerCase();
  const compact: string[] = [];
  const endOf: number[] = [];
  for (let at = 0; at < title.length; at++) {
    if (/\s/.test(title[at])) continue;
    compact.push(title[at].toLowerCase());
    endOf.push(at + 1);
  }
  const text = compact.join('');
  const word = /[\p{L}\p{N}]/u;
  for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
    const after = at + wanted.length;
    if (!word.test(text[at - 1] ?? '') && !word.test(text[after] ?? '')) return endOf[after - 1];
  }
  return null;
}

// Spotify's title past the work's own name: "Pt. 1: Aria. "Fido speccihio!"".
function trackNameWithin(title: string, catalogue: string | null): string {
  const end = catalogue ? catalogueEnd(title, catalogue) : null;
  const rest = end === null ? '' : title.slice(end).replace(/^[\s,:;.–—-]+/, '');
  return rest || title;
}

// Opus numbers repeat from one composer to the next, so only a composer's own catalogue can tie a
// Spotify title to a work.
const SHARED_NUMBERING = new Set(['op', 'woo']);

function foldingCatalogue(work: ProjectedRecordingWork): string | null {
  const own = work.catalogues.find((entry) => !SHARED_NUMBERING.has(entry.normalizedSystem));
  return own ? `${own.system} ${own.number}` : null;
}

type Folded = { catalogue: string; tracks: AlbumTrack[] };

// An album track MusicBrainz knows no work for joins the card of the work its title names by
// catalogue number on the same Spotify album, so one performance stays on one card. It keeps
// Spotify's title, marked as such, and stays out of MusicBrainz's numbering.
function foldIntoWorkCards(
  performances: Map<string, CardMember[]>,
  tracks: AlbumTrack[],
): { folded: Map<string, Folded>; albumTracks: AlbumTrack[] } {
  const cardsOnAlbum = new Map<string, { cardKey: string; catalogue: string }[]>();
  for (const [cardKey, members] of performances) {
    const catalogue = foldingCatalogue(members[0].work);
    if (!catalogue) continue;
    for (const albumId of new Set(members.map((member) => member.occurrence.spotifyAlbumId))) {
      cardsOnAlbum.set(albumId, [...(cardsOnAlbum.get(albumId) ?? []), { cardKey, catalogue }]);
    }
  }
  const folded = new Map<string, Folded>();
  const albumTracks: AlbumTrack[] = [];
  for (const track of tracks) {
    const named = (cardsOnAlbum.get(track.occurrence.spotifyAlbumId) ?? []).filter(
      ({ catalogue }) => catalogueEnd(track.occurrence.providerTitle, catalogue) !== null,
    );
    // Two performances, or two works, the title could belong to: no guess.
    if (named.length !== 1) {
      albumTracks.push(track);
      continue;
    }
    const { cardKey, catalogue } = named[0];
    const into = folded.get(cardKey) ?? { catalogue, tracks: [] };
    into.tracks.push(track);
    folded.set(cardKey, into);
  }
  // The same part named twice means several performances on the album, and which one the card's
  // is would be a guess.
  for (const [cardKey, { catalogue, tracks: candidates }] of folded) {
    const names = candidates.map((track) =>
      trackNameWithin(track.occurrence.providerTitle, catalogue).toLowerCase(),
    );
    if (new Set(names).size === names.length) continue;
    folded.delete(cardKey);
    albumTracks.push(...candidates);
  }
  return { folded, albumTracks };
}

// Spotify repeats the work in each part's title ("Stabat Mater in G Minor: I. Stabat Mater"). A
// heading, up to a colon, that a track shares with the track before or after it becomes its section.
export function albumSections(titles: string[]): (string | null)[] {
  const shared = (title: string, other: string | undefined): string | null => {
    let heading = null;
    for (let at = title.indexOf(': '); at > 0; at = title.indexOf(': ', at + 1)) {
      if (!other?.startsWith(title.slice(0, at + 2))) break;
      heading = title.slice(0, at);
    }
    return heading;
  };
  return titles.map((title, i) => shared(title, titles[i - 1]) ?? shared(title, titles[i + 1]));
}

// Classical tracks with no MusicBrainz work, one card per Spotify album: titled by the album,
// tracks named by Spotify and in album order, never numbered as movements.
function albumCards(
  tracks: AlbumTrack[],
  likedTrackIds: Set<string>,
  addedAtByTrackId: Map<string, string>,
): LibraryWork[] {
  const byAlbum = new Map<string, AlbumTrack[]>();
  for (const track of tracks) {
    const albumId = track.occurrence.spotifyAlbumId;
    byAlbum.set(albumId, [...(byAlbum.get(albumId) ?? []), track]);
  }
  return Array.from(byAlbum, ([albumId, members]): LibraryWork => {
    const ordered = [...members].sort(
      (left, right) =>
        left.occurrence.discNumber - right.occurrence.discNumber ||
        left.occurrence.trackNumber - right.occurrence.trackNumber,
    );
    const head = ordered[0].occurrence;
    // Only a composer every track agrees on; a compilation of several stays blank.
    const composers = new Set(ordered.map((member) => member.listedComposer));
    const composer = composers.size === 1 ? [...composers][0] : null;
    const { tint, ink } = tintFor(albumId);
    const sections = albumSections(ordered.map(({ occurrence }) => occurrence.providerTitle));
    const addedAt = ordered
      .map((member) => addedAtByTrackId.get(member.occurrence.spotifyTrackId))
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);
    return {
      id: `album:${albumId}`,
      workId: '',
      recordingId: '',
      composer: composer ? shortName(composer) : null,
      composerFull: composer,
      composerId: null,
      composerImage: null,
      era: null,
      years: '',
      title: head.providerAlbumTitle,
      nickname: null,
      catalog: null,
      year: null,
      performer: null,
      ensemble: null,
      album: head.providerAlbumTitle ?? '',
      albumId,
      cover: head.imageUrl,
      tint,
      ink,
      movements: ordered.map(({ occurrence }, index) => ({
        n: index + 1,
        position: index + 1,
        roman: '',
        // The card says these are Spotify's titles; marking every row would only repeat it.
        name: occurrence.providerTitle.slice(sections[index] ? sections[index].length + 2 : 0),
        unnamed: false,
        section: sections[index],
        missing: false,
        durationMs: occurrence.durationMs,
        duration: formatDuration(occurrence.durationMs),
        liked: likedTrackIds.has(occurrence.spotifyTrackId),
        trackId: occurrence.spotifyTrackId,
        uri: `spotify:track:${occurrence.spotifyTrackId}`,
      })),
      unmatched: true,
      addedAt: addedAt ?? null,
      gaps: Array.from(new Set(ordered.flatMap((member) => member.gaps.map((item) => item.code)))),
      ownLink: null,
    };
  });
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
