'use server';

import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { matchingAlbums } from '@/lib/db/album-search';
import { workSearchQuery } from '@/lib/db/work-search';
import {
  albumWindowView,
  ALBUM_WINDOW_SIZE,
  readAlbumWindow,
  type AlbumWindowView,
} from '@/lib/gaps/album-window';
import { spotifyTrack } from '@/lib/db/schema';
import { musicBrainzApi } from '@/lib/musicbrainz';
import { anchorTracksByIsrc } from '@/lib/musicbrainz-ingest';
import { isrcEligibleGaps, isrcGapReleases } from '@/lib/gaps/isrc';
import { magicIsrcLink } from '@/lib/musicbrainz-edit-links';
import { checkAuth } from './auth';
import type { AlbumRow, AlbumState, AlbumTrackRow } from '../lib/album-state';
import {
  loadMusicBrainzAlbumRows,
  loadMusicBrainzAlbumTracks,
} from '../lib/musicbrainz-album-coverage';

export type AlbumList = {
  albums: AlbumRow[];
  /** Browsing: the window of albums read. Null when searching. */
  window: AlbumWindowView | null;
  /** Searching: the title search stopped at this many albums, so there may be more. */
  searchLimited: boolean;
};

// A window of albums (`from`, in Spotify ID order), or the best title matches for `search`; the
// state filter applies to those, never the whole library.
export async function getAlbums(
  state?: AlbumState,
  search?: string,
  from: string | null = null,
): Promise<AlbumList> {
  await checkAuth();
  const words = search ? workSearchQuery(search) : null;
  const window = words ? null : await readAlbumWindow(from);
  const albumIds = words
    ? (
        await db.all<{ spotifyId: string }>(
          sql`select spotify_id as spotifyId from (${matchingAlbums(words, ALBUM_WINDOW_SIZE)})`,
        )
      ).map((row) => row.spotifyId)
    : window!.albumIds;
  const albums = await loadMusicBrainzAlbumRows(albumIds);
  return {
    albums: albums
      .filter((album) => (state ? album.state === state : true))
      .sort((a, b) => b.tracks - a.tracks),
    window: window && albumWindowView(window),
    searchLimited: words !== null && albumIds.length >= ALBUM_WINDOW_SIZE,
  };
}

export async function getAlbumTracks(albumId: string): Promise<AlbumTrackRow[]> {
  await checkAuth();
  return loadMusicBrainzAlbumTracks(albumId);
}

// Uses bot/MagicISRC eligibility, not the gap list: already-ledgered ISRCs must not be seeded into
// a new submission.
export async function getIsrcSubmissionLinks(
  albumIds: string[],
): Promise<Record<string, { href: string; missing: number }>> {
  await checkAuth();
  if (albumIds.length === 0) return {};

  const links: Record<string, { href: string; missing: number }> = {};
  for (const release of isrcGapReleases(await isrcEligibleGaps({ albumIds }))) {
    links[release.albumId] = {
      href: magicIsrcLink(release.releaseMbid, release.gaps),
      missing: release.missing,
    };
  }
  return links;
}

/** Scoped to one album to stay within MusicBrainz's one-request-per-second rule. */
export async function recheckAlbum(
  albumId: string,
): Promise<{ resolved: number; anchored: number; tracks: number }> {
  await checkAuth();

  // An ISRC identifies a recording without a release, so this works for albums whose release
  // MusicBrainz lacks.
  const { anchored: resolved } = await anchorTracksByIsrc(musicBrainzApi('interactive'), {
    albumId,
  });

  const [totals] = await db
    .select({
      tracks: sql<number>`count(*)`,
      anchored: sql<number>`count(distinct case when exists (
        select 1 from track_recording tr where tr.spotify_track_id = ${spotifyTrack.spotifyId}
      ) then ${spotifyTrack.spotifyId} end)`,
    })
    .from(spotifyTrack)
    .where(eq(spotifyTrack.spotifyAlbumId, albumId));

  return { resolved, ...totals };
}
