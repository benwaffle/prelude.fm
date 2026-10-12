// Harmony seeds a brand-new release; duplicating an existing edition or recordings is expensive for
// other editors to merge. Pure: a failed or skipped lookup arrives as a `LookupState` and never
// reads as "nothing found".
import {
  isVariousArtists,
  looseName,
  orderedSeedTracks,
  titleLikeness,
  type ReleaseSeed,
} from './release-seed';

export type LookupState<T> =
  | { state: 'done'; value: T }
  | { state: 'failed'; error: string }
  | { state: 'skipped'; reason: string };

/** `empty` when the lookup failed or was skipped. */
export function doneOr<T>(lookup: LookupState<T>, empty: T): T {
  return lookup.state === 'done' ? lookup.value : empty;
}

/** None when the lookup did not run to completion. */
export function precheckHits(isrcs: LookupState<PrecheckIsrcs>): PrecheckIsrcHit[] {
  return isrcs.state === 'done' ? isrcs.value.hits : [];
}

export type PrecheckReleaseHit = {
  mbid: string;
  title: string;
  artist: string;
  date: string | null;
  country: string | null;
  barcode: string | null;
  trackCount: number | null;
  media: number | null;
  groupMbid: string | null;
  groupTitle: string | null;
  artistMbids: string[];
  likeness: 'same' | 'similar';
};

export type PrecheckGroupHit = {
  mbid: string;
  title: string;
  artist: string;
  firstReleaseDate: string | null;
  primaryType: string | null;
  artistMbids: string[];
  likeness: 'same' | 'similar';
};

export type PrecheckIsrcHit = {
  isrc: string;
  recordingMbid: string;
  recordingTitle: string;
  /** Absent on checks stored before it was kept. */
  lengthMs?: number | null;
  groups: { mbid: string; title: string }[];
};

export type PrecheckIsrcs = {
  asked: number;
  withoutIsrc: number;
  hits: PrecheckIsrcHit[];
};

export type MbArtistCandidate = {
  mbid: string;
  name: string;
  disambiguation: string | null;
  type: string | null;
};

export type ArtistMatch =
  | { state: 'linked'; artist: MbArtistCandidate }
  | { state: 'several-linked'; candidates: MbArtistCandidate[] }
  | { state: 'name-match'; artist: MbArtistCandidate }
  | { state: 'ambiguous'; candidates: MbArtistCandidate[] }
  | { state: 'not-found' }
  | { state: 'not-looked-up'; reason: string }
  | { state: 'failed'; error: string };

export type ArtistRole = 'composer' | 'performer' | 'composer-and-performer' | 'couldnt-tell';

export type ArtistRoleEvidence = {
  composerWorks: number;
  performerCredits: number;
  type: string | null;
  disambiguation: string | null;
};

export type ArtistSuggestion = {
  spotifyId: string | null;
  name: string;
  tracks: number;
  onAlbum: boolean;
  match: ArtistMatch;
  role: ArtistRole;
  roleWhy: string;
};

export type ExistingVerdict =
  | 'possible-duplicate'
  | 'new-edition'
  | 'maybe-edition'
  | 'recordings-exist'
  | 'looks-new'
  | 'couldnt-tell';

export type PrecheckLink = { label: string; href: string };

export type ChecklistItem = { key: string; text: string; links?: PrecheckLink[] };

export type ReleasePrecheck = {
  version: 1;
  seed: ReleaseSeed;
  searchedArtist: string | null;
  releases: LookupState<PrecheckReleaseHit[]>;
  groups: LookupState<PrecheckGroupHit[]>;
  isrcs: LookupState<PrecheckIsrcs>;
  artists: ArtistSuggestion[];
  existing: { verdict: ExistingVerdict; headline: string; links: PrecheckLink[] };
  checklist: ChecklistItem[];
};

export const releaseUrl = (mbid: string) => `https://musicbrainz.org/release/${mbid}`;
export const releaseGroupUrl = (mbid: string) => `https://musicbrainz.org/release-group/${mbid}`;
export const recordingUrl = (mbid: string) => `https://musicbrainz.org/recording/${mbid}`;
export const artistUrl = (mbid: string) => `https://musicbrainz.org/artist/${mbid}`;

export function likeTitled<T extends { title: string }>(
  albumTitle: string,
  hits: T[],
): (T & { likeness: 'same' | 'similar' })[] {
  return hits.flatMap((hit) => {
    const likeness = titleLikeness(albumTitle, hit.title);
    return likeness === 'different' ? [] : [{ ...hit, likeness }];
  });
}

// Classical titles are generic, so a title match only counts when a performer agrees.
// `other-artists` becomes `unknown` when one of our own performers is unidentified.
export type CreditMatch = 'performer' | 'composer-only' | 'other-artists' | 'unknown';

export function creditMatch(hitArtistMbids: string[], artists: ArtistSuggestion[]): CreditMatch {
  const performers = new Set<string>();
  const composers = new Set<string>();
  let unidentifiedPerformer = false;
  for (const artist of artists) {
    const mbid = matchedMbid(artist.match);
    if (artist.role === 'composer' || artist.role === 'composer-and-performer') {
      if (mbid) composers.add(mbid);
    }
    if (artist.role !== 'composer') {
      if (mbid) performers.add(mbid);
      else unidentifiedPerformer = true;
    }
  }
  if (hitArtistMbids.length === 0) return 'unknown';
  if (hitArtistMbids.some((mbid) => performers.has(mbid))) return 'performer';
  if (hitArtistMbids.every((mbid) => composers.has(mbid))) return 'composer-only';
  return unidentifiedPerformer ? 'unknown' : 'other-artists';
}

// Possibly the same album entered without a barcode. Dropped when its credit names a different
// performer.
export function possibleDuplicates(
  seed: ReleaseSeed,
  releases: PrecheckReleaseHit[],
  artists: ArtistSuggestion[],
): PrecheckReleaseHit[] {
  return releases.filter(
    (release) =>
      release.likeness === 'same' &&
      release.trackCount === seed.tracks.length &&
      creditMatch(release.artistMbids, artists) !== 'other-artists',
  );
}

export type GroupCandidate = {
  mbid: string;
  title: string;
  via: 'recordings' | 'performer' | 'composer-only' | 'unknown';
};

export const strongCandidate = (group: GroupCandidate) =>
  group.via === 'recordings' || group.via === 'performer';

export function candidateGroups(
  seed: ReleaseSeed,
  releases: PrecheckReleaseHit[],
  groups: PrecheckGroupHit[],
  isrcHits: PrecheckIsrcHit[],
  artists: ArtistSuggestion[],
): GroupCandidate[] {
  const out = new Map<string, GroupCandidate>();
  const rank: Record<GroupCandidate['via'], number> = {
    recordings: 0,
    performer: 1,
    'composer-only': 2,
    unknown: 3,
  };
  const offer = (candidate: GroupCandidate) => {
    const current = out.get(candidate.mbid);
    if (!current || rank[candidate.via] < rank[current.via]) out.set(candidate.mbid, candidate);
  };
  // A recording already on a same-named group is the strongest sign of another edition; other names
  // say nothing.
  for (const hit of isrcHits) {
    for (const group of hit.groups) {
      if (titleLikeness(seed.title, group.title) === 'different') continue;
      offer({ ...group, via: 'recordings' });
    }
  }
  const byTitle = [
    ...groups.map((group) => ({ mbid: group.mbid, title: group.title, credit: group.artistMbids })),
    ...releases.flatMap((release) =>
      release.groupMbid
        ? [
            {
              mbid: release.groupMbid,
              title: release.groupTitle ?? release.title,
              credit: release.artistMbids,
            },
          ]
        : [],
    ),
  ];
  for (const hit of byTitle) {
    const match = creditMatch(hit.credit, artists);
    if (match === 'other-artists') continue;
    offer({ mbid: hit.mbid, title: hit.title, via: match });
  }
  return [...out.values()].sort((a, b) => rank[a.via] - rank[b.via]);
}

export function strongGroupsOf(precheck: ReleasePrecheck): GroupCandidate[] {
  return candidateGroups(
    precheck.seed,
    doneOr(precheck.releases, []),
    doneOr(precheck.groups, []),
    precheckHits(precheck.isrcs),
    precheck.artists,
  ).filter(strongCandidate);
}

function failures(parts: [string, LookupState<unknown>][]): string[] {
  return parts.flatMap(([label, state]) =>
    state.state === 'failed'
      ? [`${label} failed (${state.error})`]
      : state.state === 'skipped'
        ? [`${label} not run (${state.reason})`]
        : [],
  );
}

const GROUP_NOTE: Record<GroupCandidate['via'], string> = {
  recordings: 'holds its recordings',
  performer: 'same title and performer',
  'composer-only': 'same title; credits only the composer',
  unknown: 'same title; performers not comparable',
};

function groupLinks(groups: GroupCandidate[]): PrecheckLink[] {
  return groups.map((group) => ({
    label: `${group.title} (${GROUP_NOTE[group.via]})`,
    href: releaseGroupUrl(group.mbid),
  }));
}

// Ordered by what costs other editors most if missed. "Looks new" needs all three lookups to have
// run.
export function existingVerdict(
  seed: ReleaseSeed,
  releases: LookupState<PrecheckReleaseHit[]>,
  groups: LookupState<PrecheckGroupHit[]>,
  isrcs: LookupState<PrecheckIsrcs>,
  artists: ArtistSuggestion[],
): ReleasePrecheck['existing'] {
  const releaseHits = doneOr(releases, []);
  const groupHits = doneOr(groups, []);
  const isrcHits = precheckHits(isrcs);

  const duplicates = possibleDuplicates(seed, releaseHits, artists);
  if (duplicates.length > 0) {
    return {
      verdict: 'possible-duplicate',
      headline: `MusicBrainz may already have this album without its barcode: ${duplicates.length === 1 ? 'a release' : `${duplicates.length} releases`} with the same title and ${seed.tracks.length} tracks. Check before adding — Harmony would create a duplicate.`,
      links: duplicates.map((release) => ({
        label: `${release.title}${release.artist ? ` — ${release.artist}` : ''}${release.date ? ` (${release.date})` : ''}`,
        href: releaseUrl(release.mbid),
      })),
    };
  }

  const candidates = candidateGroups(seed, releaseHits, groupHits, isrcHits, artists);
  const strong = candidates.filter(strongCandidate);
  const weak = candidates.filter((group) => !strongCandidate(group));
  const recordingsLine =
    isrcHits.length > 0
      ? ` ${recordingCount(isrcHits)} of its recordings already exist (found by ISRC).`
      : '';
  const weakLine =
    weak.length > 0
      ? ` ${weak.length} more group(s) share the title but their performers could not be compared.`
      : '';
  if (strong.length > 0) {
    return {
      verdict: 'new-edition',
      headline: `Looks like a new edition of ${strong.length === 1 ? 'an existing release group' : `one of ${strong.length} existing release groups`}. Attach the new release to it rather than creating a group.${recordingsLine}${weakLine}`,
      links: groupLinks(candidates),
    };
  }

  if (isrcHits.length > 0) {
    return {
      verdict: 'recordings-exist',
      headline: `No release of this album found, but ${recordingCount(isrcHits)} of its recordings already exist (found by ISRC). Reuse them rather than adding new recordings.${weakLine}`,
      links: groupLinks(weak),
    };
  }

  if (weak.length > 0) {
    return {
      verdict: 'maybe-edition',
      headline: `Couldn't tell whether this is a new edition: ${weak.length} release group(s) share the title, but their credit does not name a performer we could compare. Open them and compare performers before adding.`,
      links: groupLinks(weak),
    };
  }

  const failed = failures([
    ['Release search', releases],
    ['Release group search', groups],
    ['ISRC lookup', isrcs],
  ]);
  if (failed.length > 0) {
    return {
      verdict: 'couldnt-tell',
      headline: `Couldn't tell whether MusicBrainz has it: ${failed.join('; ')}. Nothing was found by the lookups that did run.`,
      links: [],
    };
  }
  return {
    verdict: 'looks-new',
    headline:
      'Nothing found: no release or release group with a similar title credits these performers, and no ISRC has a recording. Looks missing — though an edition under a different title would not show up here.',
    links: [],
  };
}

function recordingCount(hits: PrecheckIsrcHit[]): number {
  return new Set(hits.map((hit) => hit.isrc)).size;
}

export function artistMatchFrom(
  name: string,
  linked: MbArtistCandidate[],
  searched: LookupState<MbArtistCandidate[]>,
): ArtistMatch {
  const uniqueLinked = [...new Map(linked.map((artist) => [artist.mbid, artist])).values()];
  if (uniqueLinked.length === 1) return { state: 'linked', artist: uniqueLinked[0] };
  if (uniqueLinked.length > 1) return { state: 'several-linked', candidates: uniqueLinked };
  if (searched.state === 'failed') return { state: 'failed', error: searched.error };
  if (searched.state === 'skipped') return { state: 'not-looked-up', reason: searched.reason };
  const exact = searched.value.filter((artist) => looseName(artist.name) === looseName(name));
  if (exact.length === 1) return { state: 'name-match', artist: exact[0] };
  if (exact.length > 1) return { state: 'ambiguous', candidates: exact };
  return { state: 'not-found' };
}

const PERFORMER_WORDS =
  /\b(pianist|violinist|violist|cellist|organist|harpsichordist|guitarist|lutenist|flautist|flutist|oboist|clarinettist|clarinetist|bassoonist|hornist|trumpeter|percussionist|harpist|conductor|singer|soprano|mezzo|alto|contralto|tenor|baritone|bass-baritone|countertenor|ensemble|orchestra|quartet|trio|quintet|choir|chorus|consort|band|performer|player|instrumentalist)\b/i;

const PERFORMER_TYPES = new Set(['orchestra', 'choir', 'group']);

// Our cache is the first witness, then MusicBrainz's type and disambiguation. Nothing is inferred
// from a name.
export function artistRole(evidence: ArtistRoleEvidence | null): {
  role: ArtistRole;
  why: string;
} {
  if (!evidence) return { role: 'couldnt-tell', why: 'no MusicBrainz artist to ask about' };
  const reasons: string[] = [];
  let composer = false;
  let performer = false;
  if (evidence.composerWorks > 0) {
    composer = true;
    reasons.push(`composer of ${evidence.composerWorks} work(s) in our cache`);
  }
  if (evidence.performerCredits > 0) {
    performer = true;
    reasons.push(`performs on ${evidence.performerCredits} recording(s) in our cache`);
  }
  if (!composer && !performer) {
    const type = evidence.type?.toLocaleLowerCase('en') ?? '';
    const disambiguation = evidence.disambiguation ?? '';
    if (PERFORMER_TYPES.has(type)) {
      performer = true;
      reasons.push(`MusicBrainz type is ${evidence.type}`);
    }
    if (/\bcomposer\b/i.test(disambiguation)) composer = true;
    if (PERFORMER_WORDS.test(disambiguation)) performer = true;
    if (disambiguation && (composer || performer)) {
      reasons.push(`MusicBrainz describes them as “${disambiguation}”`);
    }
  }
  if (composer && performer) return { role: 'composer-and-performer', why: reasons.join('; ') };
  if (composer) return { role: 'composer', why: reasons.join('; ') };
  if (performer) return { role: 'performer', why: reasons.join('; ') };
  return {
    role: 'couldnt-tell',
    why: 'not in our cache as a composer or performer, and MusicBrainz does not say',
  };
}

export function matchedMbid(match: ArtistMatch): string | null {
  return match.state === 'linked' || match.state === 'name-match' ? match.artist.mbid : null;
}

const MOVEMENT_ONLY =
  /^(?:[IVXLC]+|\d+)[.)]\s|^(?:allegro|adagio|andante|largo|presto|vivace|moderato|allegretto|lento|grave|menuet(?:to)?|minuet|scherzo|rondo|finale|gigue|sarabande|courante|allemande|gavotte|bourr[ée]e|air|aria|prelude|pr[ée]lude|fugue)\b/i;

const WORK_MARKERS =
  /\b(op\.?|opus|bwv|k\.|kv|hwv|rv|hob\.?|d\.|woo|l\.|sz\.|no\.|nr\.|symphon|sonata|concerto|suite|quartet)\b/i;

const STORE_SUFFIX =
  /(?:\(|\[|\s-\s)[^()[\]]*\b(remaster(?:ed)?|live|bonus(?: track)?|single version|radio edit|mono|stereo)\b/i;

/** Where the seed cannot tell (no composer identified), the item says so. */
export function classicalChecklist(
  seed: ReleaseSeed,
  artists: ArtistSuggestion[],
  existing: ReleasePrecheck['existing'],
  isrcs: LookupState<PrecheckIsrcs>,
): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const tracks = orderedSeedTracks(seed);
  const total = tracks.length;

  if (seed.source === 'library') {
    items.push({
      key: 'seed-from-library',
      text: 'Spotify could not be read, so these checks used our stored copy: album artists are unknown and track artists are unordered.',
    });
  }

  if (existing.verdict === 'possible-duplicate') {
    items.push({
      key: 'possible-duplicate',
      text: 'Open the matching release first. If it is this album, add the barcode to it instead of adding a new release.',
      links: existing.links,
    });
  }
  if (existing.verdict === 'new-edition') {
    items.push({
      key: 'attach-release-group',
      text: 'In the release editor, set the release group to the existing one rather than letting it create a new group.',
      links: existing.links,
    });
  }
  if (existing.verdict === 'maybe-edition') {
    items.push({
      key: 'compare-release-groups',
      text: 'Compare the performers of the same-titled release groups first. If one is this performance, set it as the release group.',
      links: existing.links,
    });
  }
  if (isrcs.state === 'done' && isrcs.value.hits.length > 0) {
    const reused = new Set(isrcs.value.hits.map((hit) => hit.isrc)).size;
    items.push({
      key: 'reuse-recordings',
      text: `${reused} of ${total} tracks already have a MusicBrainz recording with the same ISRC. In the Recordings tab, pick those instead of adding new recordings.`,
    });
  }

  const roleBySpotify = new Map(
    artists.map((artist) => [artist.spotifyId ?? `name:${looseName(artist.name)}`, artist.role]),
  );
  const roleOf = (artist: { spotifyId: string | null; name: string }) =>
    roleBySpotify.get(artist.spotifyId ?? `name:${looseName(artist.name)}`) ?? 'couldnt-tell';
  const isComposer = (role: ArtistRole) => role === 'composer' || role === 'composer-and-performer';
  let composerWithOthers = 0;
  let noComposerKnown = 0;
  for (const track of tracks) {
    const roles = track.artists.map(roleOf);
    const composers = roles.filter(isComposer).length;
    if (composers === 0) noComposerKnown++;
    else if (roles.length > composers) composerWithOthers++;
  }
  if (composerWithOthers > 0) {
    items.push({
      key: 'composer-with-performers',
      text: `On ${composerWithOthers} of ${total} tracks Spotify credits the composer together with performers. The classical style guide wants only the composer as track artist and the main performers as recording artist; Harmony copies Spotify's credit into both.`,
    });
  }
  if (noComposerKnown > 0) {
    items.push({
      key: 'composer-unknown',
      text: `On ${noComposerKnown} of ${total} tracks none of the credited artists is known to be a composer — couldn't tell whether Spotify credits the composer at all. Check the track artists.`,
    });
  }

  const movementOnly = tracks.filter(
    (track) => !track.title.includes(':') && MOVEMENT_ONLY.test(track.title.trim()),
  );
  if (movementOnly.length > 0) {
    items.push({
      key: 'movement-without-work',
      text: `${movementOnly.length} title(s) look like a movement without its work (e.g. “${movementOnly[0].title}”). The guide asks for “Work: Movement” when the release groups movements under a work.`,
    });
  }
  const dashed = tracks.filter((track) => {
    if (track.title.includes(':')) return false;
    const [left] = track.title.split(' - ');
    return track.title.includes(' - ') && WORK_MARKERS.test(left);
  });
  if (dashed.length > 0) {
    items.push({
      key: 'dash-separator',
      text: `${dashed.length} title(s) put “ - ” between work and movement (e.g. “${dashed[0].title}”) where the guide uses “: ”.`,
    });
  }
  const suffixed = tracks.filter((track) => STORE_SUFFIX.test(track.title));
  if (suffixed.length > 0) {
    items.push({
      key: 'store-suffix',
      text: `${suffixed.length} title(s) carry a store suffix such as “Remastered” or “Live” (e.g. “${suffixed[0].title}”) that may not be printed on the release.`,
    });
  }

  const discs = new Set(tracks.map((track) => track.disc)).size;
  if (discs > 1) {
    items.push({
      key: 'multi-disc',
      text: `${discs} discs: check the media split matches the printed discs.`,
    });
  }

  const withoutIsrc = tracks.filter((track) => !track.isrc).length;
  if (withoutIsrc > 0) {
    items.push({
      key: 'missing-isrc',
      text: `${withoutIsrc} of ${total} tracks have no ISRC on Spotify, so they could not be checked for existing recordings.`,
    });
  }

  const unlinked = artists.filter((artist) => artist.match.state !== 'linked');
  if (unlinked.length > 0) {
    items.push({
      key: 'unlinked-artists',
      text: `${unlinked.length} of ${artists.length} artists are not linked to their Spotify page in MusicBrainz, so Harmony cannot pick them — choose them by hand (see the artist list).`,
    });
  }

  if (seed.albumArtists.some((artist) => isVariousArtists(artist.name))) {
    items.push({
      key: 'various-artists',
      text: 'Spotify’s album artist is “Various Artists”. Decide the release artist per the classical style guide rather than taking Harmony’s.',
    });
  }

  return items;
}

export function assemblePrecheck(parts: {
  seed: ReleaseSeed;
  searchedArtist: string | null;
  releases: LookupState<PrecheckReleaseHit[]>;
  groups: LookupState<PrecheckGroupHit[]>;
  isrcs: LookupState<PrecheckIsrcs>;
  artists: ArtistSuggestion[];
}): ReleasePrecheck {
  const existing = existingVerdict(
    parts.seed,
    parts.releases,
    parts.groups,
    parts.isrcs,
    parts.artists,
  );
  return {
    version: 1,
    ...parts,
    existing,
    checklist: classicalChecklist(parts.seed, parts.artists, existing, parts.isrcs),
  };
}
