'use server';

import { eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { spotifyAlbum, spotifyTrack } from '@/lib/db/schema';
import { musicBrainzApi } from '@/lib/musicbrainz';
import { anchorTracksByIsrc } from '@/lib/musicbrainz-ingest';
import { isrcEligibleGapsByRelease, magicIsrcLink } from '@/lib/musicbrainz-contributions';
import { checkAuth } from './auth';
import type { AlbumRow, AlbumState, AlbumTrackRow, Coverage } from '../lib/album-state';
import {
  loadMusicBrainzAlbumRows,
  loadMusicBrainzAlbumTracks,
  summarizeMusicBrainzAlbumCoverage,
} from '../lib/musicbrainz-album-coverage';

export async function getCoverage(): Promise<Coverage> {
  await checkAuth();
  return summarizeMusicBrainzAlbumCoverage(await loadMusicBrainzAlbumRows());
}

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

/**
 * Canonical ISRC contribution links for albums on screen.
 *
 * Delegates to bot/MagicISRC eligibility, not the displayed cache-gap list:
 * already-ledgered ISRCs stay visible on the contribution work item but must
 * not be seeded into a new submission. Positions are MusicBrainz
 * medium/positions, and nothing is returned unless the complete release
 * passes the submission standard.
 */
export async function getIsrcSubmissionLinks(
  albumIds: string[],
): Promise<Record<string, { href: string; missing: number }>> {
  await checkAuth();
  if (albumIds.length === 0) return {};

  const wanted = new Set(albumIds);
  const links: Record<string, { href: string; missing: number }> = {};
  for (const release of await isrcEligibleGapsByRelease(5_000)) {
    if (!wanted.has(release.albumId)) continue;
    links[release.albumId] = {
      href: magicIsrcLink(release.releaseMbid, release.gaps),
      missing: release.missing,
    };
  }
  return links;
}

/**
 * Ask MusicBrainz about one album's ISRCs again, now.
 *
 * Contributing to MusicBrainz changes nothing here until something re-reads
 * it, and until this existed the only way to see whether a submission worked
 * was to re-run the whole backfill from a terminal. That is a poor loop for a
 * page whose entire purpose is to send you off to make those submissions.
 *
 * Scoped to one album so it stays within MusicBrainz's one-request-per-second
 * rule without making anyone wait: even a long box set is a handful of
 * batched queries.
 */
export async function recheckAlbum(
  albumId: string,
): Promise<{ resolved: number; anchored: number; tracks: number }> {
  await checkAuth();

  /*
   * The same resolution the loose-ISRC sweep does, scoped to one album. An
   * ISRC identifies a recording without reference to a release, which is
   * what makes this useful here: the albums a person re-checks from this
   * page are mostly the ones whose release MusicBrainz does not have.
   */
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

/** Albums never checked against MusicBrainz, newest first — the backfill's queue. */
export async function countUnchecked(): Promise<number> {
  await checkAuth();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(spotifyAlbum)
    .where(isNull(spotifyAlbum.mbCheckedAt));
  return row.n;
}
