'use server';

import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
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

export async function getAlbums(state?: AlbumState, search?: string): Promise<AlbumRow[]> {
  await checkAuth();
  const albums = await loadMusicBrainzAlbumRows();
  const needle = search?.trim().toLocaleLowerCase();
  return albums
    .filter((album) => (state ? album.state === state : true))
    .filter((album) => (needle ? album.title.toLocaleLowerCase().includes(needle) : true))
    .sort((a, b) => b.tracks - a.tracks);
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

  const wanted = new Set(albumIds);
  const links: Record<string, { href: string; missing: number }> = {};
  for (const release of isrcGapReleases(await isrcEligibleGaps())) {
    if (!wanted.has(release.albumId)) continue;
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
