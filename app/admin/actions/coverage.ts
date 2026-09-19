'use server';

import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { spotifyAlbum, spotifyTrack, trackWorkPartV2, work, workPartV2 } from '@/lib/db/schema';
import { checkAuth } from './auth';
import {
  type AlbumRow,
  type AlbumState,
  type AlbumTrackRow,
  type Coverage,
} from '../lib/album-state';

function deriveState(row: {
  tracks: number;
  anchored: number;
  mbReleaseId: string | null;
  candidates: number | null;
  checked: Date | null;
}): AlbumState {
  if (row.checked === null) return 'unchecked';
  if (row.tracks > 0 && row.anchored === row.tracks) return 'anchored';
  if (row.anchored > 0) return 'partial';
  if (row.mbReleaseId) return 'needs_isrcs';
  // Several releases sharing the barcode is not the same as none having it:
  // one needs a release adding, the other needs the right one choosing, and
  // confusing them is how duplicate releases get created.
  if ((row.candidates ?? 0) > 1) return 'ambiguous';
  return 'absent';
}

async function loadAlbums(): Promise<AlbumRow[]> {
  const rows = await db
    .select({
      id: spotifyAlbum.spotifyId,
      title: spotifyAlbum.title,
      year: spotifyAlbum.year,
      upc: spotifyAlbum.upc,
      mbReleaseId: spotifyAlbum.mbReleaseId,
      candidates: spotifyAlbum.mbReleaseCandidates,
      checked: spotifyAlbum.mbCheckedAt,
      tracks: sql<number>`count(distinct ${spotifyTrack.spotifyId})`,
      anchored: sql<number>`count(distinct case when ${spotifyTrack.mbRecordingId} is not null then ${spotifyTrack.spotifyId} end)`,
      works: sql<number>`count(distinct ${workPartV2.workId})`,
      worksLinked: sql<number>`count(distinct case when ${work.musicbrainzId} is not null then ${work.id} end)`,
    })
    .from(spotifyAlbum)
    .leftJoin(spotifyTrack, eq(spotifyTrack.spotifyAlbumId, spotifyAlbum.spotifyId))
    .leftJoin(trackWorkPartV2, eq(trackWorkPartV2.spotifyTrackId, spotifyTrack.spotifyId))
    .leftJoin(workPartV2, eq(workPartV2.id, trackWorkPartV2.workPartId))
    .leftJoin(work, eq(work.id, workPartV2.workId))
    .groupBy(spotifyAlbum.spotifyId);

  return rows.map((row) => ({ ...row, state: deriveState(row) }));
}

export async function getCoverage(): Promise<Coverage> {
  await checkAuth();
  const albums = await loadAlbums();
  const byState = new Map<AlbumState, { albums: number; tracks: number }>();
  let tracks = 0;
  let anchoredTracks = 0;
  for (const album of albums) {
    tracks += album.tracks;
    anchoredTracks += album.anchored;
    const entry = byState.get(album.state) ?? { albums: 0, tracks: 0 };
    entry.albums++;
    entry.tracks += album.tracks;
    byState.set(album.state, entry);
  }
  const order: AlbumState[] = [
    'anchored',
    'partial',
    'needs_isrcs',
    'absent',
    'ambiguous',
    'unchecked',
  ];
  return {
    albums: albums.length,
    tracks,
    anchoredTracks,
    byState: order
      .filter((state) => byState.has(state))
      .map((state) => ({ state, ...byState.get(state)! })),
  };
}

export async function getAlbums(state?: AlbumState, search?: string): Promise<AlbumRow[]> {
  await checkAuth();
  const albums = await loadAlbums();
  const needle = search?.trim().toLocaleLowerCase();
  return albums
    .filter((album) => (state ? album.state === state : true))
    .filter((album) => (needle ? album.title.toLocaleLowerCase().includes(needle) : true))
    .sort((a, b) => b.tracks - a.tracks);
}

export async function getAlbumTracks(albumId: string): Promise<AlbumTrackRow[]> {
  await checkAuth();
  const rows = await db
    .select({
      id: spotifyTrack.spotifyId,
      title: spotifyTrack.title,
      discNumber: spotifyTrack.discNumber,
      trackNumber: spotifyTrack.trackNumber,
      isrc: spotifyTrack.isrc,
      mbRecordingId: spotifyTrack.mbRecordingId,
      workId: work.id,
      workTitle: work.title,
      partId: workPartV2.id,
      partLabel: workPartV2.label,
      partTitle: workPartV2.title,
      partPosition: workPartV2.position,
    })
    .from(spotifyTrack)
    .leftJoin(trackWorkPartV2, eq(trackWorkPartV2.spotifyTrackId, spotifyTrack.spotifyId))
    .leftJoin(workPartV2, eq(workPartV2.id, trackWorkPartV2.workPartId))
    .leftJoin(work, eq(work.id, workPartV2.workId))
    .where(eq(spotifyTrack.spotifyAlbumId, albumId))
    .orderBy(spotifyTrack.discNumber, spotifyTrack.trackNumber, workPartV2.position);

  // A track linked to several movements arrives as several rows. Collapsing
  // them here keeps one row per track, which is what a track is.
  const byTrack = new Map<string, AlbumTrackRow>();
  for (const row of rows) {
    let track = byTrack.get(row.id);
    if (!track) {
      track = {
        id: row.id,
        title: row.title,
        discNumber: row.discNumber,
        trackNumber: row.trackNumber,
        isrc: row.isrc,
        mbRecordingId: row.mbRecordingId,
        parts: [],
      };
      byTrack.set(row.id, track);
    }
    if (row.workId != null && row.workTitle != null && row.partId != null) {
      track.parts.push({
        partId: row.partId,
        workId: row.workId,
        workTitle: row.workTitle,
        label: row.partLabel,
        title: row.partTitle,
      });
    }
  }
  return [...byTrack.values()];
}

/**
 * The ISRCs an album could contribute, for seeding a submission.
 *
 * Fetched for the albums on screen rather than with the album list, because a
 * 121-track box set carries more ISRC text than every other field on its row
 * put together.
 *
 * `discs` comes back so the caller can tell whether it may place the ISRCs by
 * position. MagicISRC seeds by medium and track; we do not store MusicBrainz's
 * medium layout, so only a single-disc album can be placed safely. Guessing on
 * a multi-disc release would attach ISRCs to the wrong recordings, which is
 * exactly the error nobody notices until much later.
 */
export async function getIsrcSeeds(
  albumIds: string[],
): Promise<Record<string, { discs: number; isrcs: string[] }>> {
  await checkAuth();
  if (albumIds.length === 0) return {};

  const rows = await db
    .select({
      albumId: spotifyTrack.spotifyAlbumId,
      discNumber: spotifyTrack.discNumber,
      trackNumber: spotifyTrack.trackNumber,
      isrc: spotifyTrack.isrc,
    })
    .from(spotifyTrack)
    .where(and(inArray(spotifyTrack.spotifyAlbumId, albumIds), isNotNull(spotifyTrack.isrc)))
    .orderBy(spotifyTrack.spotifyAlbumId, spotifyTrack.discNumber, spotifyTrack.trackNumber);

  const seeds: Record<string, { discs: number; isrcs: string[] }> = {};
  const discs: Record<string, Set<number>> = {};
  for (const row of rows) {
    seeds[row.albumId] ??= { discs: 1, isrcs: [] };
    discs[row.albumId] ??= new Set();
    discs[row.albumId].add(row.discNumber);
    seeds[row.albumId].isrcs.push(row.isrc as string);
  }
  for (const albumId of Object.keys(seeds)) seeds[albumId].discs = discs[albumId].size;
  return seeds;
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

/** Works the parser invented that MusicBrainz has never confirmed. */
export async function getUnconfirmedWorks(limit = 50) {
  await checkAuth();
  return db
    .select({
      id: work.id,
      title: work.title,
      form: work.form,
      parts: sql<number>`(select count(*) from work_part_v2 p where p.work_id = ${work.id})`,
      recordings: sql<number>`(select count(*) from recording_v2 r where r.work_id = ${work.id})`,
    })
    .from(work)
    .where(isNull(work.musicbrainzId))
    .orderBy(desc(sql`(select count(*) from recording_v2 r where r.work_id = ${work.id})`))
    .limit(limit);
}
