'use server';

import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { spotifyAlbum, spotifyTrack, trackWorkPartV2, work, workPartV2 } from '@/lib/db/schema';
import { checkAuth } from './auth';

/**
 * Why an album is, or is not, anchored to MusicBrainz.
 *
 * The states are ordered by what they cost to fix, because that is the only
 * thing that decides what to do next. An album MusicBrainz already holds needs
 * ISRCs submitting, which is minutes; an album it has never heard of needs the
 * release entering, which is an evening.
 */
export type AlbumState =
  /** Every track resolves to a MusicBrainz recording. MusicBrainz can speak for it. */
  | 'anchored'
  /** Some tracks resolve. The rest are missing ISRCs on a release we can find. */
  | 'partial'
  /** MusicBrainz has the release but no ISRCs reach our tracks. */
  | 'needs_isrcs'
  /** No release with this barcode. Someone has to add it. */
  | 'absent'
  /** Several releases share the barcode, so none of them identifies this album. */
  | 'ambiguous'
  /** Nobody has asked MusicBrainz about this barcode yet. */
  | 'unchecked';

export type AlbumRow = {
  id: string;
  title: string;
  year: number | null;
  tracks: number;
  anchored: number;
  worksLinked: number;
  works: number;
  upc: string | null;
  mbReleaseId: string | null;
  state: AlbumState;
};

export const STATE_LABEL: Record<AlbumState, string> = {
  anchored: 'Anchored',
  partial: 'Partly anchored',
  needs_isrcs: 'Needs ISRCs',
  absent: 'Not in MusicBrainz',
  ambiguous: 'Ambiguous barcode',
  unchecked: 'Not checked',
};

function deriveState(row: {
  tracks: number;
  anchored: number;
  mbReleaseId: string | null;
  checked: Date | null;
  upc: string | null;
}): AlbumState {
  if (row.checked === null) return 'unchecked';
  if (row.tracks > 0 && row.anchored === row.tracks) return 'anchored';
  if (row.anchored > 0) return 'partial';
  if (row.mbReleaseId) return 'needs_isrcs';
  // A barcode we looked up and did not resolve is either genuinely absent or
  // shared by several releases; only the second leaves us with a barcode and
  // no release, so they can be told apart.
  return row.upc ? 'absent' : 'ambiguous';
}

async function loadAlbums(): Promise<AlbumRow[]> {
  const rows = await db
    .select({
      id: spotifyAlbum.spotifyId,
      title: spotifyAlbum.title,
      year: spotifyAlbum.year,
      upc: spotifyAlbum.upc,
      mbReleaseId: spotifyAlbum.mbReleaseId,
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

export type Coverage = {
  albums: number;
  tracks: number;
  anchoredTracks: number;
  byState: { state: AlbumState; albums: number; tracks: number }[];
};

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

export type AlbumTrackRow = {
  id: string;
  title: string;
  discNumber: number;
  trackNumber: number;
  isrc: string | null;
  mbRecordingId: string | null;
  workId: number | null;
  workTitle: string | null;
  partLabel: string | null;
  partTitle: string | null;
};

export async function getAlbumTracks(albumId: string): Promise<AlbumTrackRow[]> {
  await checkAuth();
  return db
    .select({
      id: spotifyTrack.spotifyId,
      title: spotifyTrack.title,
      discNumber: spotifyTrack.discNumber,
      trackNumber: spotifyTrack.trackNumber,
      isrc: spotifyTrack.isrc,
      mbRecordingId: spotifyTrack.mbRecordingId,
      workId: work.id,
      workTitle: work.title,
      partLabel: workPartV2.label,
      partTitle: workPartV2.title,
    })
    .from(spotifyTrack)
    .leftJoin(trackWorkPartV2, eq(trackWorkPartV2.spotifyTrackId, spotifyTrack.spotifyId))
    .leftJoin(workPartV2, eq(workPartV2.id, trackWorkPartV2.workPartId))
    .leftJoin(work, eq(work.id, workPartV2.workId))
    .where(eq(spotifyTrack.spotifyAlbumId, albumId))
    .orderBy(spotifyTrack.discNumber, spotifyTrack.trackNumber);
}

/** The ISRCs an album could contribute, in track order. */
export async function getAlbumIsrcs(albumId: string): Promise<string[]> {
  await checkAuth();
  const rows = await db
    .select({ isrc: spotifyTrack.isrc })
    .from(spotifyTrack)
    .where(and(eq(spotifyTrack.spotifyAlbumId, albumId), isNotNull(spotifyTrack.isrc)))
    .orderBy(spotifyTrack.discNumber, spotifyTrack.trackNumber);
  return rows.map((row) => row.isrc as string);
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
