// Uses the gateway's `interactive` channel: a person is waiting. Caches results so opening the
// Inbox spends no requests.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import {
  mbRecordingCredit,
  mbWork,
  spotifyAlbum,
  spotifyArtist,
  spotifyTrack,
  trackArtists,
} from './db/schema';
import { artistCreditOf, luceneQuote, type MbArtistCreditJson } from './musicbrainz';
import { createMbSession, type MbSession } from './musicbrainz-session';
import { normalizeIsrc } from './isrc';
import {
  readMissingReleases,
  writeMissingRelease,
  type MissingRelease,
} from './missing-release-store';
import {
  artistMatchFrom,
  artistRole,
  assemblePrecheck,
  likeTitled,
  matchedMbid,
  type ArtistMatch,
  type ArtistRoleEvidence,
  type ArtistSuggestion,
  type LookupState,
  type MbArtistCandidate,
  type PrecheckGroupHit,
  type PrecheckIsrcHit,
  type PrecheckIsrcs,
  type PrecheckReleaseHit,
  type ReleasePrecheck,
} from './release-precheck';
import { isVariousArtists, seedArtists, titleWords, type ReleaseSeed } from './release-seed';
import { getSpotifyAlbumSeed } from './spotify-app-client';

const ISRC_CHUNK = 20;
const URL_CHUNK = 50;
/** Unlinked artists searched by name per album; the rest say they were not looked up. */
export const NAME_SEARCH_LIMIT = 12;

const PERFORMER_ROLES = [
  'instrument',
  'vocal',
  'conductor',
  'performing orchestra',
  'performer',
  'chorus master',
  'concertmaster',
];

async function lookup<T>(run: () => Promise<T>): Promise<LookupState<T>> {
  try {
    return { state: 'done', value: await run() };
  } catch (error) {
    return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Live from Spotify, or our stored copy (marked as such) when Spotify cannot be read. */
export async function loadReleaseSeed(albumId: string): Promise<ReleaseSeed> {
  try {
    const { album, tracks } = await getSpotifyAlbumSeed(albumId);
    return {
      albumId,
      title: album.name,
      upc: album.external_ids?.upc ?? null,
      releaseDate: album.release_date || null,
      label: album.label || null,
      source: 'spotify',
      albumArtists: album.artists.map((artist) => ({ spotifyId: artist.id, name: artist.name })),
      tracks: tracks.map((track) => ({
        disc: track.disc_number,
        position: track.track_number,
        title: track.name,
        durationMs: track.duration_ms,
        isrc: track.external_ids?.isrc ? normalizeIsrc(track.external_ids.isrc) : null,
        artists: track.artists.map((artist) => ({ spotifyId: artist.id, name: artist.name })),
      })),
    };
  } catch {
    return libraryReleaseSeed(albumId);
  }
}

async function libraryReleaseSeed(albumId: string): Promise<ReleaseSeed> {
  const [album] = await db
    .select({ title: spotifyAlbum.title, upc: spotifyAlbum.upc })
    .from(spotifyAlbum)
    .where(eq(spotifyAlbum.spotifyId, albumId));
  if (!album) throw new Error(`No Spotify album ${albumId} in the library`);
  const tracks = await db
    .select({
      id: spotifyTrack.spotifyId,
      title: spotifyTrack.title,
      disc: spotifyTrack.discNumber,
      position: spotifyTrack.trackNumber,
      durationMs: spotifyTrack.durationMs,
      isrc: spotifyTrack.isrc,
    })
    .from(spotifyTrack)
    .where(eq(spotifyTrack.spotifyAlbumId, albumId));
  const credits =
    tracks.length === 0
      ? []
      : await db
          .select({
            trackId: trackArtists.spotifyTrackId,
            spotifyId: spotifyArtist.spotifyId,
            name: spotifyArtist.name,
          })
          .from(trackArtists)
          .innerJoin(spotifyArtist, eq(spotifyArtist.spotifyId, trackArtists.spotifyArtistId))
          .where(
            inArray(
              trackArtists.spotifyTrackId,
              tracks.map((track) => track.id),
            ),
          );
  return {
    albumId,
    title: album.title,
    upc: album.upc,
    source: 'library',
    albumArtists: [],
    tracks: tracks.map((track) => ({
      disc: track.disc,
      position: track.position,
      title: track.title,
      durationMs: track.durationMs,
      isrc: track.isrc ? normalizeIsrc(track.isrc) : null,
      artists: credits
        .filter((credit) => credit.trackId === track.id)
        .map((credit) => ({ spotifyId: credit.spotifyId, name: credit.name })),
    })),
  };
}

const creditMbids = (credit: MbArtistCreditJson | undefined) =>
  artistCreditOf(credit).map((part) => part.artistId);
const creditText = (credit: MbArtistCreditJson | undefined) =>
  (credit ?? []).map((part) => part.name ?? part.artist?.name ?? '').join(', ');

/** Punctuation is dropped, so nothing needs escaping. */
function titleClause(field: string, title: string): string | null {
  const words = titleWords(title);
  return words.length === 0 ? null : `${field}:(${words.join(' ')})`;
}

function artistClause(artist: string | null): string {
  const quoted = artist ? luceneQuote(artist) : null;
  return quoted ? ` AND artist:${quoted}` : '';
}

async function searchReleases(
  mb: MbSession,
  seed: ReleaseSeed,
  artist: string | null,
): Promise<PrecheckReleaseHit[]> {
  const clause = titleClause('release', seed.title);
  if (!clause) return [];
  const result = await mb.get<{
    releases?: {
      id: string;
      title: string;
      date?: string;
      country?: string;
      barcode?: string | null;
      'track-count'?: number;
      media?: unknown[];
      'artist-credit'?: MbArtistCreditJson;
      'release-group'?: { id: string; title: string };
    }[];
  }>(`/release?query=${encodeURIComponent(clause + artistClause(artist))}&fmt=json&limit=15`);
  return likeTitled(
    seed.title,
    (result?.releases ?? []).map((release) => ({
      mbid: release.id,
      title: release.title,
      artist: creditText(release['artist-credit']),
      date: release.date ?? null,
      country: release.country ?? null,
      barcode: release.barcode ?? null,
      trackCount: release['track-count'] ?? null,
      media: release.media?.length ?? null,
      groupMbid: release['release-group']?.id ?? null,
      groupTitle: release['release-group']?.title ?? null,
      artistMbids: creditMbids(release['artist-credit']),
    })),
  );
}

async function searchGroups(
  mb: MbSession,
  seed: ReleaseSeed,
  artist: string | null,
): Promise<PrecheckGroupHit[]> {
  const clause = titleClause('releasegroup', seed.title);
  if (!clause) return [];
  const result = await mb.get<{
    'release-groups'?: {
      id: string;
      title: string;
      'first-release-date'?: string;
      'primary-type'?: string;
      'artist-credit'?: MbArtistCreditJson;
    }[];
  }>(`/release-group?query=${encodeURIComponent(clause + artistClause(artist))}&fmt=json&limit=15`);
  return likeTitled(
    seed.title,
    (result?.['release-groups'] ?? []).map((group) => ({
      mbid: group.id,
      title: group.title,
      artist: creditText(group['artist-credit']),
      firstReleaseDate: group['first-release-date'] || null,
      primaryType: group['primary-type'] ?? null,
      artistMbids: creditMbids(group['artist-credit']),
    })),
  );
}

async function lookUpIsrcs(mb: MbSession, seed: ReleaseSeed): Promise<PrecheckIsrcs> {
  const isrcs = [...new Set(seed.tracks.flatMap((track) => (track.isrc ? [track.isrc] : [])))];
  const withoutIsrc = seed.tracks.filter((track) => !track.isrc).length;
  const hits: PrecheckIsrcHit[] = [];
  for (let index = 0; index < isrcs.length; index += ISRC_CHUNK) {
    for (const { isrc, recording } of await mb.recordingsByIsrcs(
      isrcs.slice(index, index + ISRC_CHUNK),
    )) {
      const groups = new Map<string, { mbid: string; title: string }>();
      for (const release of recording.releases ?? []) {
        const group = release['release-group'];
        if (group) groups.set(group.id, { mbid: group.id, title: group.title });
      }
      hits.push({
        isrc,
        recordingMbid: recording.id,
        recordingTitle: recording.title,
        lengthMs: recording.length ?? null,
        groups: [...groups.values()],
      });
    }
  }
  return { asked: isrcs.length, withoutIsrc, hits };
}

type RawArtist = {
  id: string;
  name: string;
  disambiguation?: string;
  type?: string | null;
};

const candidateOf = (artist: RawArtist): MbArtistCandidate => ({
  mbid: artist.id,
  name: artist.name,
  disambiguation: artist.disambiguation || null,
  type: artist.type ?? null,
});

async function linkedArtists(
  mb: MbSession,
  spotifyIds: string[],
): Promise<Map<string, MbArtistCandidate[]>> {
  const linked = new Map<string, MbArtistCandidate[]>();
  type RawUrl = {
    resource: string;
    relations?: { 'target-type'?: string; artist?: RawArtist }[];
  };
  for (let index = 0; index < spotifyIds.length; index += URL_CHUNK) {
    const chunk = spotifyIds.slice(index, index + URL_CHUNK);
    const params = chunk
      .map((id) => `resource=${encodeURIComponent(`https://open.spotify.com/artist/${id}`)}`)
      .join('&');
    const result = await mb.get<RawUrl & { urls?: RawUrl[] }>(
      `/url?${params}&inc=artist-rels&fmt=json`,
    );
    // One resource answers with the URL itself; several answer with a list.
    const urls = result?.urls ?? (result?.resource ? [result] : []);
    for (const url of urls) {
      const id = /open\.spotify\.com\/artist\/([A-Za-z0-9]+)/.exec(url.resource)?.[1];
      if (!id) continue;
      const artists = (url.relations ?? []).flatMap((relation) =>
        relation['target-type'] === 'artist' && relation.artist
          ? [candidateOf(relation.artist)]
          : [],
      );
      linked.set(id, [...(linked.get(id) ?? []), ...artists]);
    }
  }
  return linked;
}

async function searchArtistByName(mb: MbSession, name: string): Promise<MbArtistCandidate[]> {
  const quoted = luceneQuote(name);
  if (!quoted) return [];
  const result = await mb.get<{ artists?: RawArtist[] }>(
    `/artist?query=${encodeURIComponent(`artist:${quoted}`)}&fmt=json&limit=8`,
  );
  return (result?.artists ?? []).map(candidateOf);
}

async function cacheRoleEvidence(
  mbids: string[],
): Promise<Map<string, { composerWorks: number; performerCredits: number }>> {
  const out = new Map<string, { composerWorks: number; performerCredits: number }>();
  if (mbids.length === 0) return out;
  const [composed, performed] = await Promise.all([
    db
      .select({ mbid: mbWork.composerMbid, n: sql<number>`count(*)` })
      .from(mbWork)
      .where(inArray(mbWork.composerMbid, mbids))
      .groupBy(mbWork.composerMbid),
    db
      .select({
        mbid: mbRecordingCredit.artistMbid,
        n: sql<number>`count(distinct ${mbRecordingCredit.recordingMbid})`,
      })
      .from(mbRecordingCredit)
      .where(
        and(
          inArray(mbRecordingCredit.artistMbid, mbids),
          inArray(mbRecordingCredit.role, PERFORMER_ROLES),
        ),
      )
      .groupBy(mbRecordingCredit.artistMbid),
  ]);
  for (const mbid of mbids) out.set(mbid, { composerWorks: 0, performerCredits: 0 });
  for (const row of composed) if (row.mbid) out.get(row.mbid)!.composerWorks = row.n;
  for (const row of performed) out.get(row.mbid)!.performerCredits = row.n;
  return out;
}

async function suggestArtists(mb: MbSession, seed: ReleaseSeed): Promise<ArtistSuggestion[]> {
  const rows = seedArtists(seed);
  const spotifyIds = rows.flatMap((row) => (row.artist.spotifyId ? [row.artist.spotifyId] : []));
  const linkedState = await lookup(() => linkedArtists(mb, spotifyIds));
  const linked = linkedState.state === 'done' ? linkedState.value : new Map();

  let nameSearches = 0;
  const matches: ArtistMatch[] = [];
  for (const row of rows) {
    if (linkedState.state === 'failed') {
      matches.push({ state: 'failed', error: `Spotify-link lookup: ${linkedState.error}` });
      continue;
    }
    const byLink = row.artist.spotifyId ? (linked.get(row.artist.spotifyId) ?? []) : [];
    let searched: LookupState<MbArtistCandidate[]>;
    if (byLink.length > 0) {
      searched = { state: 'skipped', reason: 'linked' };
    } else if (nameSearches >= NAME_SEARCH_LIMIT) {
      searched = {
        state: 'skipped',
        reason: `only the ${NAME_SEARCH_LIMIT} most-credited unlinked artists are searched by name`,
      };
    } else {
      nameSearches++;
      searched = await lookup(() => searchArtistByName(mb, row.artist.name));
    }
    matches.push(artistMatchFrom(row.artist.name, byLink, searched));
  }

  const mbids = [...new Set(matches.flatMap((match) => matchedMbid(match) ?? []))];
  const evidence = await cacheRoleEvidence(mbids);
  return rows.map((row, index) => {
    const match = matches[index];
    const mbid = matchedMbid(match);
    const artist = match.state === 'linked' || match.state === 'name-match' ? match.artist : null;
    const roleEvidence: ArtistRoleEvidence | null =
      mbid && artist
        ? {
            ...(evidence.get(mbid) ?? { composerWorks: 0, performerCredits: 0 }),
            type: artist.type,
            disambiguation: artist.disambiguation,
          }
        : null;
    const { role, why } = artistRole(roleEvidence);
    return {
      spotifyId: row.artist.spotifyId,
      name: row.artist.name,
      tracks: row.tracks,
      onAlbum: row.onAlbum,
      match,
      role,
      roleWhy: why,
    };
  });
}

export async function runReleasePrecheck(
  albumId: string,
): Promise<{ precheck: ReleasePrecheck; requests: number }> {
  const mb = createMbSession('interactive');
  const seed = await loadReleaseSeed(albumId);
  const searchedArtist =
    seed.albumArtists.find((artist) => !isVariousArtists(artist.name))?.name ?? null;
  // Independent lookups; the gateway still sends their requests one at a time.
  const [artists, releases, groups, isrcs] = await Promise.all([
    suggestArtists(mb, seed),
    lookup(() => searchReleases(mb, seed, searchedArtist)),
    lookup(() => searchGroups(mb, seed, searchedArtist)),
    seed.tracks.some((track) => track.isrc)
      ? lookup(() => lookUpIsrcs(mb, seed))
      : ({ state: 'skipped', reason: 'Spotify gives no ISRCs for this album' } as const),
  ]);
  return {
    precheck: assemblePrecheck({ seed, searchedArtist, releases, groups, isrcs, artists }),
    requests: mb.requests,
  };
}

export async function refreshReleasePrecheck(albumId: string): Promise<ReleasePrecheck> {
  const { precheck, requests } = await runReleasePrecheck(albumId);
  await writeMissingRelease(albumId, 'precheck', precheck, requests);
  return precheck;
}

export type CachedPrecheck = { result: ReleasePrecheck; requests: number | null; checkedAt: Date };

export function cachedPrecheckOf({ precheck }: MissingRelease): CachedPrecheck | null {
  return precheck
    ? { result: precheck.value, requests: precheck.requests, checkedAt: precheck.recordedAt }
    : null;
}

export async function cachedReleasePrechecks(
  albumIds: string[],
): Promise<Map<string, CachedPrecheck>> {
  const stored = await readMissingReleases(albumIds);
  return new Map(
    [...stored].flatMap(([albumId, stages]) => {
      const cached = cachedPrecheckOf(stages);
      return cached ? [[albumId, cached] as const] : [];
    }),
  );
}
