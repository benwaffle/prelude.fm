/**
 * Runs the missing-release pre-checks against live MusicBrainz and caches the
 * result, so that opening the Inbox never spends requests.
 *
 * Every request goes through the gateway on the `interactive` channel: a
 * person is waiting for it. An album costs roughly two title searches, one
 * ISRC search per twenty tracks, one Spotify-link lookup per fifty artists,
 * and at most `NAME_SEARCH_LIMIT` artist name searches.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './db';
import {
  mbRecordingCredit,
  mbReleasePrecheck,
  mbWork,
  spotifyAlbum,
  spotifyArtist,
  spotifyTrack,
  trackArtists,
} from './db/schema';
import { mbGet } from './musicbrainz';
import type { MusicBrainzChannel } from './musicbrainz-gateway';
import { normalizeIsrc } from './isrc';
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

const CHANNEL: MusicBrainzChannel = 'interactive';
const ISRC_CHUNK = 20;
const URL_CHUNK = 50;
/** Unlinked artists searched by name per album; the rest say they were not looked up. */
export const NAME_SEARCH_LIMIT = 12;

/** Performer relationship types, as `mb_recording_credit.role` stores them. */
const PERFORMER_ROLES = [
  'instrument',
  'vocal',
  'conductor',
  'performing orchestra',
  'performer',
  'chorus master',
  'concertmaster',
];

type Counter = { requests: number };

async function counted<T>(counter: Counter, path: string): Promise<T | null> {
  counter.requests++;
  return mbGet<T>(path, CHANNEL);
}

async function lookup<T>(run: () => Promise<T>): Promise<LookupState<T>> {
  try {
    return { state: 'done', value: await run() };
  } catch (error) {
    return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------- seed */

/**
 * The album as Harmony would read it: live from Spotify, or — when Spotify
 * cannot be read — our stored copy, marked as such.
 */
export async function loadReleaseSeed(
  albumId: string,
  database: DatabaseExecutor = db,
): Promise<ReleaseSeed> {
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
    return libraryReleaseSeed(albumId, database);
  }
}

async function libraryReleaseSeed(
  albumId: string,
  database: DatabaseExecutor,
): Promise<ReleaseSeed> {
  const [album] = await database
    .select({ title: spotifyAlbum.title, upc: spotifyAlbum.upc })
    .from(spotifyAlbum)
    .where(eq(spotifyAlbum.spotifyId, albumId));
  if (!album) throw new Error(`No Spotify album ${albumId} in the library`);
  const tracks = await database
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
      : await database
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

/* ---------------------------------------------------------- MusicBrainz */

type RawCredit = { name?: string; artist?: { id: string; name: string } }[];
const creditMbids = (credit: RawCredit | undefined) =>
  (credit ?? []).flatMap((part) => (part.artist ? [part.artist.id] : []));
const creditText = (credit: RawCredit | undefined) =>
  (credit ?? []).map((part) => part.name ?? part.artist?.name ?? '').join(', ');

/** Title words as a Lucene OR clause; punctuation is dropped, so nothing needs escaping. */
function titleClause(field: string, title: string): string | null {
  const words = titleWords(title);
  return words.length === 0 ? null : `${field}:(${words.join(' ')})`;
}

function artistClause(artist: string | null): string {
  if (!artist) return '';
  return ` AND artist:"${artist.replace(/["\\]/g, ' ')}"`;
}

async function searchReleases(
  counter: Counter,
  seed: ReleaseSeed,
  artist: string | null,
): Promise<PrecheckReleaseHit[]> {
  const clause = titleClause('release', seed.title);
  if (!clause) return [];
  const result = await counted<{
    releases?: {
      id: string;
      title: string;
      date?: string;
      country?: string;
      barcode?: string | null;
      'track-count'?: number;
      media?: unknown[];
      'artist-credit'?: RawCredit;
      'release-group'?: { id: string; title: string };
    }[];
  }>(
    counter,
    `/release?query=${encodeURIComponent(clause + artistClause(artist))}&fmt=json&limit=15`,
  );
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
  counter: Counter,
  seed: ReleaseSeed,
  artist: string | null,
): Promise<PrecheckGroupHit[]> {
  const clause = titleClause('releasegroup', seed.title);
  if (!clause) return [];
  const result = await counted<{
    'release-groups'?: {
      id: string;
      title: string;
      'first-release-date'?: string;
      'primary-type'?: string;
      'artist-credit'?: RawCredit;
    }[];
  }>(
    counter,
    `/release-group?query=${encodeURIComponent(clause + artistClause(artist))}&fmt=json&limit=15`,
  );
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

async function lookUpIsrcs(counter: Counter, seed: ReleaseSeed): Promise<PrecheckIsrcs> {
  const isrcs = [...new Set(seed.tracks.flatMap((track) => (track.isrc ? [track.isrc] : [])))];
  const withoutIsrc = seed.tracks.filter((track) => !track.isrc).length;
  const hits: PrecheckIsrcHit[] = [];
  for (let index = 0; index < isrcs.length; index += ISRC_CHUNK) {
    const chunk = isrcs.slice(index, index + ISRC_CHUNK);
    const wanted = new Set(chunk);
    const query = chunk.map((isrc) => `isrc:${isrc}`).join(' OR ');
    const result = await counted<{
      recordings?: {
        id: string;
        title: string;
        length?: number | null;
        isrcs?: string[];
        releases?: { 'release-group'?: { id: string; title: string } }[];
      }[];
    }>(counter, `/recording?query=${encodeURIComponent(query)}&fmt=json&limit=100`);
    for (const recording of result?.recordings ?? []) {
      const groups = new Map<string, { mbid: string; title: string }>();
      for (const release of recording.releases ?? []) {
        const group = release['release-group'];
        if (group) groups.set(group.id, { mbid: group.id, title: group.title });
      }
      for (const reported of recording.isrcs ?? []) {
        const isrc = normalizeIsrc(reported);
        if (!wanted.has(isrc)) continue;
        hits.push({
          isrc,
          recordingMbid: recording.id,
          recordingTitle: recording.title,
          lengthMs: recording.length ?? null,
          groups: [...groups.values()],
        });
      }
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

/** MusicBrainz artists linked to each Spotify artist page, by Spotify id. */
async function linkedArtists(
  counter: Counter,
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
    const result = await counted<RawUrl & { urls?: RawUrl[] }>(
      counter,
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

async function searchArtistByName(counter: Counter, name: string): Promise<MbArtistCandidate[]> {
  const result = await counted<{ artists?: RawArtist[] }>(
    counter,
    `/artist?query=${encodeURIComponent(`artist:"${name.replace(/["\\]/g, ' ')}"`)}&fmt=json&limit=8`,
  );
  return (result?.artists ?? []).map(candidateOf);
}

/** Composer and performer evidence our cache holds for these artists. */
async function cacheRoleEvidence(
  mbids: string[],
  database: DatabaseExecutor,
): Promise<Map<string, { composerWorks: number; performerCredits: number }>> {
  const out = new Map<string, { composerWorks: number; performerCredits: number }>();
  if (mbids.length === 0) return out;
  const [composed, performed] = await Promise.all([
    database
      .select({ mbid: mbWork.composerMbid, n: sql<number>`count(*)` })
      .from(mbWork)
      .where(inArray(mbWork.composerMbid, mbids))
      .groupBy(mbWork.composerMbid),
    database
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

async function suggestArtists(
  counter: Counter,
  seed: ReleaseSeed,
  database: DatabaseExecutor,
): Promise<ArtistSuggestion[]> {
  const rows = seedArtists(seed);
  const spotifyIds = rows.flatMap((row) => (row.artist.spotifyId ? [row.artist.spotifyId] : []));
  const linkedState = await lookup(() => linkedArtists(counter, spotifyIds));
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
      searched = await lookup(() => searchArtistByName(counter, row.artist.name));
    }
    matches.push(artistMatchFrom(row.artist.name, byLink, searched));
  }

  const mbids = [...new Set(matches.flatMap((match) => matchedMbid(match) ?? []))];
  const evidence = await cacheRoleEvidence(mbids, database);
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

/** Every pre-check for one album, live. Writes nothing. */
export async function runReleasePrecheck(
  albumId: string,
  database: DatabaseExecutor = db,
): Promise<{ precheck: ReleasePrecheck; requests: number }> {
  const counter: Counter = { requests: 0 };
  const seed = await loadReleaseSeed(albumId, database);
  const searchedArtist =
    seed.albumArtists.find((artist) => !isVariousArtists(artist.name))?.name ?? null;
  const artists = await suggestArtists(counter, seed, database);
  const releases = await lookup(() => searchReleases(counter, seed, searchedArtist));
  const groups = await lookup(() => searchGroups(counter, seed, searchedArtist));
  const isrcs: LookupState<PrecheckIsrcs> = seed.tracks.some((track) => track.isrc)
    ? await lookup(() => lookUpIsrcs(counter, seed))
    : { state: 'skipped', reason: 'Spotify gives no ISRCs for this album' };
  return {
    precheck: assemblePrecheck({ seed, searchedArtist, releases, groups, isrcs, artists }),
    requests: counter.requests,
  };
}

/** Run the pre-checks and cache them, replacing any earlier result. */
export async function refreshReleasePrecheck(
  albumId: string,
  database: DatabaseExecutor = db,
): Promise<ReleasePrecheck> {
  const { precheck, requests } = await runReleasePrecheck(albumId, database);
  await storeReleasePrecheck(albumId, precheck, requests, database);
  return precheck;
}

export async function storeReleasePrecheck(
  albumId: string,
  precheck: ReleasePrecheck,
  requests: number,
  database: DatabaseExecutor = db,
) {
  const checkedAt = new Date();
  await database
    .insert(mbReleasePrecheck)
    .values({ spotifyAlbumId: albumId, result: precheck, requests, checkedAt })
    .onConflictDoUpdate({
      target: mbReleasePrecheck.spotifyAlbumId,
      set: { result: precheck, requests, checkedAt },
    });
}

export type CachedPrecheck = { result: ReleasePrecheck; requests: number; checkedAt: Date };

/** Cached pre-checks for these albums. Spends no MusicBrainz requests. */
export async function cachedReleasePrechecks(
  albumIds: string[],
  database: DatabaseExecutor = db,
): Promise<Map<string, CachedPrecheck>> {
  if (albumIds.length === 0) return new Map();
  const rows = await database
    .select()
    .from(mbReleasePrecheck)
    .where(inArray(mbReleasePrecheck.spotifyAlbumId, albumIds));
  return new Map(
    rows.map((row) => [
      row.spotifyAlbumId,
      { result: row.result, requests: row.requests, checkedAt: row.checkedAt },
    ]),
  );
}
