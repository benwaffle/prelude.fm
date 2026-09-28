/**
 * Our own seed for the MusicBrainz release editor.
 *
 * Harmony seeds a release from Spotify but leaves every track pointing at a
 * new recording, so for an album whose recordings already exist somebody has
 * to pick each one by hand. We already know many of them — the pre-check
 * found recordings by ISRC, and a new edition's existing release lists its
 * recordings by position — so this seed pre-fills them.
 *
 * The rule is: pre-fill a recording only when one answer is clearly right.
 * Two recordings for one ISRC, lengths that disagree, existing releases that
 * disagree — all of those leave the track empty (MusicBrainz then creates a
 * new recording unless the person picks one) and are listed for the person.
 *
 * Field names follow https://musicbrainz.org/doc/Development/Release_Editor_Seeding.
 * The form is POSTed from the person's own browser to /release/add, so the
 * edit is theirs; nothing here submits anything.
 *
 * Everything in this file is pure.
 */
import { matchedMbid, type ArtistSuggestion, type PrecheckIsrcHit } from './release-precheck';
import {
  looseName,
  orderedSeedTracks,
  titleWords,
  type ReleaseSeed,
  type SeedArtist,
  type SeedTrack,
} from './release-seed';

export const RELEASE_ADD_URL = 'https://musicbrainz.org/release/add';

/** Release–URL "free streaming" (08445ccf-7b99-4438-9f9a-fb9ac18099ee). */
export const FREE_STREAMING_LINK_TYPE = 85;

/** How far a recording's length may be from the Spotify track's to be reused. */
export const RECORDING_LENGTH_TOLERANCE_MS = 5_000;

/**
 * What the seeded track artist credit is.
 *
 * `composer`: the classical style guide's track artist — the composer(s)
 * only. The release editor copies a track's credit onto any recording it
 * creates, so new recordings will show the composer and need their
 * performers set; reused recordings keep their own credits.
 */
export const TRACK_CREDIT_MODE: 'composer' | 'performers' = 'composer';

/* ------------------------------------------------------------ recordings */

/** A release of the same album already on MusicBrainz, as its tracklist. */
export type EditionTracklist = {
  releaseMbid: string;
  releaseTitle: string;
  tracks: {
    medium: number;
    position: number;
    title: string;
    lengthMs: number | null;
    recordingMbid: string;
  }[];
};

export type RecordingDecision =
  | {
      state: 'matched';
      recordingMbid: string;
      via: 'isrc' | 'position' | 'isrc-and-position';
      why: string;
    }
  | { state: 'ambiguous'; reason: string; candidates: string[] }
  | { state: 'none'; reason: string };

export const trackKey = (track: { disc: number; position: number }) =>
  `${track.disc}-${track.position}`;

function titlesAgree(a: string, b: string): boolean {
  const left = new Set(titleWords(a));
  const right = new Set(titleWords(b));
  if (left.size === 0 || right.size === 0) return false;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.min(left.size, right.size) >= 0.6;
}

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

type Proposal = { recordingMbid: string; why: string };

/** What the ISRC lookup says for one track. */
function byIsrc(
  track: SeedTrack,
  hits: PrecheckIsrcHit[],
): { proposal: Proposal | null; problem: string | null; candidates: string[] } {
  if (!track.isrc) return { proposal: null, problem: null, candidates: [] };
  const isrc = track.isrc.toUpperCase();
  const matching = hits.filter((hit) => hit.isrc.toUpperCase() === isrc);
  const recordings = [...new Map(matching.map((hit) => [hit.recordingMbid, hit])).values()];
  if (recordings.length === 0) return { proposal: null, problem: null, candidates: [] };
  const candidates = recordings.map((hit) => hit.recordingMbid);
  if (recordings.length > 1) {
    return {
      proposal: null,
      problem: `${recordings.length} recordings share ISRC ${isrc}`,
      candidates,
    };
  }
  const [hit] = recordings;
  if (
    typeof hit.lengthMs === 'number' &&
    Math.abs(hit.lengthMs - track.durationMs) > RECORDING_LENGTH_TOLERANCE_MS
  ) {
    return {
      proposal: null,
      problem: `the recording with ISRC ${isrc} is ${seconds(hit.lengthMs)} long, the track ${seconds(track.durationMs)}`,
      candidates,
    };
  }
  return {
    proposal: { recordingMbid: hit.recordingMbid, why: `ISRC ${isrc}` },
    problem: null,
    candidates,
  };
}

/** What the existing editions say for one track, at the same disc and position. */
function byPosition(
  track: SeedTrack,
  editions: EditionTracklist[],
): { proposal: Proposal | null; problem: string | null; candidates: string[] } {
  const agreeing: Proposal[] = [];
  const problems: string[] = [];
  for (const edition of editions) {
    const theirs = edition.tracks.find(
      (candidate) => candidate.medium === track.disc && candidate.position === track.position,
    );
    if (!theirs) continue;
    const where = `disc ${track.disc} track ${track.position} of “${edition.releaseTitle}”`;
    if (
      theirs.lengthMs === null ||
      Math.abs(theirs.lengthMs - track.durationMs) > RECORDING_LENGTH_TOLERANCE_MS
    ) {
      problems.push(
        `${where} is ${theirs.lengthMs === null ? 'of unknown length' : seconds(theirs.lengthMs)}, the track ${seconds(track.durationMs)}`,
      );
      continue;
    }
    if (!titlesAgree(track.title, theirs.title)) {
      problems.push(`${where} is titled “${theirs.title}”`);
      continue;
    }
    agreeing.push({ recordingMbid: theirs.recordingMbid, why: `same position in ${where}` });
  }
  const distinct = [
    ...new Map(agreeing.map((proposal) => [proposal.recordingMbid, proposal])).values(),
  ];
  if (distinct.length > 1) {
    return {
      proposal: null,
      problem: `existing releases put different recordings at this position`,
      candidates: distinct.map((proposal) => proposal.recordingMbid),
    };
  }
  if (distinct.length === 1) return { proposal: distinct[0], problem: null, candidates: [] };
  return { proposal: null, problem: problems[0] ?? null, candidates: [] };
}

/**
 * The recording to pre-fill for each track, or why none is.
 *
 * `editions` are existing releases of this album with the same number of
 * tracks on each disc; the caller only passes those. ISRC and position must
 * agree when both answer. A recording that would land on two tracks is
 * pulled from both.
 */
export function matchRecordings(
  seed: ReleaseSeed,
  isrcHits: PrecheckIsrcHit[],
  editions: EditionTracklist[],
): Map<string, RecordingDecision> {
  const decisions = new Map<string, RecordingDecision>();
  for (const track of orderedSeedTracks(seed)) {
    const isrc = byIsrc(track, isrcHits);
    const position = byPosition(track, editions);
    let decision: RecordingDecision;
    if (isrc.proposal && position.proposal) {
      decision =
        isrc.proposal.recordingMbid === position.proposal.recordingMbid
          ? {
              state: 'matched',
              recordingMbid: isrc.proposal.recordingMbid,
              via: 'isrc-and-position',
              why: `${isrc.proposal.why}, and ${position.proposal.why}`,
            }
          : {
              state: 'ambiguous',
              reason: `the ISRC and the existing release point at different recordings`,
              candidates: [isrc.proposal.recordingMbid, position.proposal.recordingMbid],
            };
    } else if (isrc.problem) {
      decision = { state: 'ambiguous', reason: isrc.problem, candidates: isrc.candidates };
    } else if (isrc.proposal) {
      decision = {
        state: 'matched',
        recordingMbid: isrc.proposal.recordingMbid,
        via: 'isrc',
        why: isrc.proposal.why,
      };
    } else if (position.proposal) {
      decision = {
        state: 'matched',
        recordingMbid: position.proposal.recordingMbid,
        via: 'position',
        why: position.proposal.why,
      };
    } else if (position.problem && position.candidates.length > 0) {
      decision = { state: 'ambiguous', reason: position.problem, candidates: position.candidates };
    } else if (position.problem) {
      decision = { state: 'ambiguous', reason: position.problem, candidates: [] };
    } else {
      decision = {
        state: 'none',
        reason: track.isrc
          ? 'no recording has its ISRC, and no existing release lines up'
          : 'Spotify gives no ISRC, and no existing release lines up',
      };
    }
    decisions.set(trackKey(track), decision);
  }

  const uses = new Map<string, string[]>();
  for (const [key, decision] of decisions) {
    if (decision.state !== 'matched') continue;
    uses.set(decision.recordingMbid, [...(uses.get(decision.recordingMbid) ?? []), key]);
  }
  for (const [recordingMbid, keys] of uses) {
    if (keys.length < 2) continue;
    for (const key of keys) {
      decisions.set(key, {
        state: 'ambiguous',
        reason: `the same recording would be used on ${keys.length} tracks`,
        candidates: [recordingMbid],
      });
    }
  }
  return decisions;
}

/**
 * Releases usable for position matching: same number of discs, and the same
 * number of tracks on each disc as the Spotify album.
 */
export function editionsShapedLike(
  seed: ReleaseSeed,
  editions: EditionTracklist[],
): EditionTracklist[] {
  const shape = (counts: Map<number, number>) =>
    [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([disc, n]) => `${disc}:${n}`)
      .join(',');
  const ours = new Map<number, number>();
  for (const track of seed.tracks) ours.set(track.disc, (ours.get(track.disc) ?? 0) + 1);
  return editions.filter((edition) => {
    const theirs = new Map<number, number>();
    for (const track of edition.tracks) {
      theirs.set(track.medium, (theirs.get(track.medium) ?? 0) + 1);
    }
    return shape(theirs) === shape(ours);
  });
}

/* --------------------------------------------------------------- credits */

export type CreditPart = { name: string; mbid: string | null; joinPhrase: string };

function keyOf(artist: SeedArtist) {
  return artist.spotifyId ?? `name:${looseName(artist.name)}`;
}

/** Spotify artists as credit parts, with MBIDs where the pre-check resolved them. */
function partsFor(artists: SeedArtist[], suggestions: Map<string, ArtistSuggestion>): CreditPart[] {
  return artists.map((artist, index) => {
    const suggestion = suggestions.get(keyOf(artist));
    return {
      name: artist.name,
      mbid: suggestion ? matchedMbid(suggestion.match) : null,
      joinPhrase: index < artists.length - 1 ? ', ' : '',
    };
  });
}

/**
 * The track artist credit.
 *
 * With `composer` mode, the credit is the track's composers when at least one
 * credited artist is known to be a composer; performers stay off it. When no
 * composer can be identified the Spotify credit is kept as it is — we cannot
 * tell who to leave out.
 */
export function trackCredit(
  artists: SeedArtist[],
  suggestions: Map<string, ArtistSuggestion>,
  mode: typeof TRACK_CREDIT_MODE = TRACK_CREDIT_MODE,
): { credit: CreditPart[]; shape: 'composer-only' | 'performers-only' | 'as-spotify' } {
  const roleOf = (artist: SeedArtist) => suggestions.get(keyOf(artist))?.role ?? 'couldnt-tell';
  const isComposer = (artist: SeedArtist) => {
    const role = roleOf(artist);
    return role === 'composer' || role === 'composer-and-performer';
  };
  const composers = artists.filter(isComposer);
  if (composers.length === 0)
    return { credit: partsFor(artists, suggestions), shape: 'as-spotify' };
  if (mode === 'composer') {
    return { credit: partsFor(composers, suggestions), shape: 'composer-only' };
  }
  const performers = artists.filter((artist) => roleOf(artist) !== 'composer');
  return performers.length === 0
    ? { credit: partsFor(artists, suggestions), shape: 'as-spotify' }
    : { credit: partsFor(performers, suggestions), shape: 'performers-only' };
}

/* ------------------------------------------------------------------ plan */

export type PlannedTrack = {
  disc: number;
  position: number;
  title: string;
  lengthMs: number;
  isrc: string | null;
  credit: CreditPart[];
  creditShape: 'composer-only' | 'performers-only' | 'as-spotify';
  recording: RecordingDecision;
};

export type SeedPlan = {
  version: 1;
  albumId: string;
  title: string;
  barcode: string | null;
  releaseDate: string | null;
  label: string | null;
  spotifyUrl: string;
  releaseCredit: CreditPart[];
  /** Set only when exactly one existing group shares the album's performers or recordings. */
  releaseGroupMbid: string | null;
  /** Why no group was seeded, when the pre-check found candidates. */
  releaseGroupNote: string | null;
  /** The existing releases whose tracklists were used for position matching. */
  editions: { releaseMbid: string; releaseTitle: string }[];
  tracks: PlannedTrack[];
  editNote: string;
  counts: { tracks: number; prefilled: number; ambiguous: number; none: number };
  /** What the preparation could not do, for the person (set by the runner). */
  notes: string[];
};

export function planSeed(input: {
  seed: ReleaseSeed;
  artists: ArtistSuggestion[];
  isrcHits: PrecheckIsrcHit[];
  /** Strong release-group candidates from the pre-check (shared performer or recordings). */
  strongGroups: { mbid: string; title: string }[];
  editions: EditionTracklist[];
}): SeedPlan {
  const { seed } = input;
  const suggestions = new Map(
    input.artists.map((artist) => [artist.spotifyId ?? `name:${looseName(artist.name)}`, artist]),
  );
  const editions = editionsShapedLike(seed, input.editions);
  const decisions = matchRecordings(seed, input.isrcHits, editions);
  const tracks = orderedSeedTracks(seed).map((track): PlannedTrack => {
    const { credit, shape } = trackCredit(track.artists, suggestions);
    return {
      disc: track.disc,
      position: track.position,
      title: track.title,
      lengthMs: track.durationMs,
      isrc: track.isrc,
      credit,
      creditShape: shape,
      recording: decisions.get(trackKey(track))!,
    };
  });

  const groups = [...new Map(input.strongGroups.map((group) => [group.mbid, group])).values()];
  const releaseGroupMbid = groups.length === 1 ? groups[0].mbid : null;
  const releaseGroupNote =
    groups.length > 1
      ? `${groups.length} existing release groups qualify (${groups.map((group) => group.title).join('; ')}) — choose one in the editor.`
      : null;

  const counts = {
    tracks: tracks.length,
    prefilled: tracks.filter((track) => track.recording.state === 'matched').length,
    ambiguous: tracks.filter((track) => track.recording.state === 'ambiguous').length,
    none: tracks.filter((track) => track.recording.state === 'none').length,
  };
  const spotifyUrl = `https://open.spotify.com/album/${seed.albumId}`;
  const plan: Omit<SeedPlan, 'editNote'> = {
    notes: [],
    version: 1,
    albumId: seed.albumId,
    title: seed.title,
    barcode: seed.upc,
    releaseDate: seed.releaseDate ?? null,
    label: seed.label ?? null,
    spotifyUrl,
    releaseCredit: partsFor(
      seed.albumArtists.filter((artist) => looseName(artist.name) !== 'various artists'),
      suggestions,
    ),
    releaseGroupMbid,
    releaseGroupNote,
    editions: editions.map(({ releaseMbid, releaseTitle }) => ({ releaseMbid, releaseTitle })),
    tracks,
    counts,
  };
  return { ...plan, editNote: seedEditNote(plan) };
}

/** The edit note: where the data came from and how each recording was chosen. */
export function seedEditNote(plan: Omit<SeedPlan, 'editNote'>): string {
  const lines = [`Tracklist, titles, lengths and barcode from Spotify: ${plan.spotifyUrl}`];
  if (plan.releaseGroupMbid) {
    lines.push(
      `Release group: https://musicbrainz.org/release-group/${plan.releaseGroupMbid} (existing release group of the same performance).`,
    );
  }
  const matched = plan.tracks.filter((track) => track.recording.state === 'matched');
  if (matched.length === 0) {
    lines.push('No existing recordings were pre-filled.');
  } else {
    lines.push(
      `Existing recordings pre-filled for ${matched.length} of ${plan.tracks.length} tracks:`,
    );
    for (const track of matched) {
      if (track.recording.state !== 'matched') continue;
      lines.push(
        `- ${track.disc}.${track.position}: https://musicbrainz.org/recording/${track.recording.recordingMbid} (${track.recording.why})`,
      );
    }
  }
  const unsure = plan.tracks.filter((track) => track.recording.state === 'ambiguous').length;
  if (unsure > 0)
    lines.push(`${unsure} track(s) left without a recording because the match was ambiguous.`);
  lines.push('Seeded by prelude.fm, reviewed by a human before submitting.');
  return lines.join('\n');
}

/* ---------------------------------------------------------------- fields */

function creditFields(prefix: string, credit: CreditPart[]): [string, string][] {
  return credit.flatMap((part, index) => {
    const base = `${prefix}artist_credit.names.${index}`;
    const fields: [string, string][] = [
      [`${base}.name`, part.name],
      [`${base}.join_phrase`, part.joinPhrase],
    ];
    if (part.mbid) fields.push([`${base}.mbid`, part.mbid]);
    else fields.push([`${base}.artist.name`, part.name]);
    return fields;
  });
}

/**
 * The release-editor form, as ordered name/value pairs.
 *
 * Only what we know: no country, format, catalogue number or type — the
 * editor leaves those for the person rather than us guessing.
 */
export function seedFields(plan: SeedPlan): [string, string][] {
  const fields: [string, string][] = [
    ['name', plan.title],
    ['status', 'official'],
    ['packaging', 'None'],
  ];
  if (plan.barcode) fields.push(['barcode', plan.barcode]);
  if (plan.releaseGroupMbid) fields.push(['release_group', plan.releaseGroupMbid]);
  fields.push(...creditFields('', plan.releaseCredit));

  const date = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(plan.releaseDate ?? '');
  if (date) {
    fields.push(['events.0.date.year', date[1]]);
    if (date[2]) fields.push(['events.0.date.month', String(Number(date[2]))]);
    if (date[3]) fields.push(['events.0.date.day', String(Number(date[3]))]);
  }
  if (plan.label) fields.push(['labels.0.name', plan.label]);

  const discs = [...new Set(plan.tracks.map((track) => track.disc))].sort((a, b) => a - b);
  discs.forEach((disc, mediumIndex) => {
    plan.tracks
      .filter((track) => track.disc === disc)
      .sort((a, b) => a.position - b.position)
      .forEach((track, trackIndex) => {
        const prefix = `mediums.${mediumIndex}.track.${trackIndex}.`;
        fields.push([`${prefix}number`, String(track.position)]);
        fields.push([`${prefix}name`, track.title]);
        fields.push([`${prefix}length`, String(track.lengthMs)]);
        if (track.recording.state === 'matched') {
          fields.push([`${prefix}recording`, track.recording.recordingMbid]);
        }
        fields.push(...creditFields(prefix, track.credit));
      });
  });

  fields.push(['urls.0.url', plan.spotifyUrl]);
  fields.push(['urls.0.link_type', String(FREE_STREAMING_LINK_TYPE)]);
  fields.push(['edit_note', plan.editNote]);
  return fields;
}

/**
 * The seed as a baseline for the correction record: what the person was
 * handed, including the recordings we pre-filled and the artists we credited
 * by MBID.
 */
export function seedPlanBaseline(plan: SeedPlan): ReleaseSeed {
  const artists = (credit: CreditPart[]): SeedArtist[] =>
    credit.map((part) => ({ spotifyId: null, name: part.name, mbid: part.mbid }));
  return {
    albumId: plan.albumId,
    title: plan.title,
    upc: plan.barcode,
    source: 'spotify',
    releaseDate: plan.releaseDate,
    label: plan.label,
    albumArtists: artists(plan.releaseCredit),
    tracks: plan.tracks.map((track) => ({
      disc: track.disc,
      position: track.position,
      title: track.title,
      durationMs: track.lengthMs,
      isrc: track.isrc,
      artists: artists(track.credit),
      recordingMbid: track.recording.state === 'matched' ? track.recording.recordingMbid : null,
    })),
  };
}
