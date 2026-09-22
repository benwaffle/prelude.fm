import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db, type DatabaseExecutor } from '@/lib/db';
import {
  mbRecording,
  mbRecordingWork,
  mbWork,
  spotifyAlbum,
  spotifyTrack,
  trackClassification,
  trackRecording,
} from '@/lib/db/schema';
import type { AlbumRow, AlbumState, AlbumTrackRow, Coverage } from './album-state';

/**
 * Album status facts from the provider, durable classification, anchors, and
 * the MusicBrainz cache. Parser catalogue tables are deliberately absent.
 */

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
  if ((row.candidates ?? 0) > 1) return 'ambiguous';
  return 'absent';
}

export async function loadMusicBrainzAlbumRows(
  database: DatabaseExecutor = db,
): Promise<AlbumRow[]> {
  const rows = await database
    .select({
      id: spotifyAlbum.spotifyId,
      title: spotifyAlbum.title,
      year: spotifyAlbum.year,
      upc: spotifyAlbum.upc,
      mbReleaseId: spotifyAlbum.mbReleaseId,
      candidates: spotifyAlbum.mbReleaseCandidates,
      checked: spotifyAlbum.mbCheckedAt,
      tracks: sql<number>`count(distinct ${spotifyTrack.spotifyId})`,
      anchored: sql<number>`count(distinct ${trackRecording.spotifyTrackId})`,
      classified: sql<number>`count(distinct ${trackClassification.spotifyTrackId})`,
      classical: sql<number>`count(distinct case
        when ${trackClassification.state} = 'classical'
        then ${trackClassification.spotifyTrackId} end)`,
      tracksReachingWork: sql<number>`count(distinct case
        when ${mbRecordingWork.workMbid} is not null
        then ${spotifyTrack.spotifyId} end)`,
      works: sql<number>`count(distinct ${mbRecordingWork.workMbid})`,
      worksCached: sql<number>`count(distinct ${mbWork.mbid})`,
    })
    .from(spotifyAlbum)
    .leftJoin(spotifyTrack, eq(spotifyTrack.spotifyAlbumId, spotifyAlbum.spotifyId))
    .leftJoin(trackClassification, eq(trackClassification.spotifyTrackId, spotifyTrack.spotifyId))
    .leftJoin(trackRecording, eq(trackRecording.spotifyTrackId, spotifyTrack.spotifyId))
    .leftJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, trackRecording.recordingMbid))
    .leftJoin(mbWork, eq(mbWork.mbid, mbRecordingWork.workMbid))
    .groupBy(spotifyAlbum.spotifyId);

  return rows.map((row) => ({ ...row, state: deriveState(row) }));
}

export function summarizeMusicBrainzAlbumCoverage(albums: AlbumRow[]): Coverage {
  const byState = new Map<AlbumState, { albums: number; tracks: number }>();
  let tracks = 0;
  let anchoredTracks = 0;
  let classifiedTracks = 0;
  let classicalTracks = 0;
  let tracksReachingWork = 0;

  for (const album of albums) {
    tracks += album.tracks;
    anchoredTracks += album.anchored;
    classifiedTracks += album.classified;
    classicalTracks += album.classical;
    tracksReachingWork += album.tracksReachingWork;
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
    classifiedTracks,
    classicalTracks,
    tracksReachingWork,
    byState: order
      .filter((state) => byState.has(state))
      .map((state) => ({ state, ...byState.get(state)! })),
  };
}

export async function loadMusicBrainzAlbumTracks(
  albumId: string,
  database: DatabaseExecutor = db,
): Promise<AlbumTrackRow[]> {
  const parentWork = alias(mbWork, 'parent_work');
  const rows = await database
    .select({
      id: spotifyTrack.spotifyId,
      title: spotifyTrack.title,
      discNumber: spotifyTrack.discNumber,
      trackNumber: spotifyTrack.trackNumber,
      isrc: spotifyTrack.isrc,
      recordingMbid: trackRecording.recordingMbid,
      recordingTitle: mbRecording.title,
      recordingDetail: mbRecording.detail,
      classificationState: trackClassification.state,
      classificationProvenance: trackClassification.provenance,
      classificationReason: trackClassification.reason,
      workMbid: mbRecordingWork.workMbid,
      workTitle: mbWork.title,
      workDetail: mbWork.detail,
      parentMbid: mbWork.parentMbid,
      parentTitle: parentWork.title,
    })
    .from(spotifyTrack)
    .leftJoin(trackRecording, eq(trackRecording.spotifyTrackId, spotifyTrack.spotifyId))
    .leftJoin(mbRecording, eq(mbRecording.mbid, trackRecording.recordingMbid))
    .leftJoin(trackClassification, eq(trackClassification.spotifyTrackId, spotifyTrack.spotifyId))
    .leftJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, trackRecording.recordingMbid))
    .leftJoin(mbWork, eq(mbWork.mbid, mbRecordingWork.workMbid))
    .leftJoin(parentWork, eq(parentWork.mbid, mbWork.parentMbid))
    .where(eq(spotifyTrack.spotifyAlbumId, albumId))
    .orderBy(spotifyTrack.discNumber, spotifyTrack.trackNumber, mbWork.orderingKey, mbWork.title);

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
        recordingMbid: row.recordingMbid,
        recordingTitle: row.recordingTitle,
        recordingDetail: row.recordingDetail,
        classification:
          row.classificationState && row.classificationProvenance
            ? {
                state: row.classificationState,
                provenance: row.classificationProvenance,
                reason: row.classificationReason,
              }
            : null,
        works: [],
      };
      byTrack.set(row.id, track);
    }
    if (row.workMbid) {
      track.works.push({
        mbid: row.workMbid,
        title: row.workTitle,
        detail: row.workDetail,
        parentMbid: row.parentMbid,
        parentTitle: row.parentTitle,
      });
    }
  }
  return [...byTrack.values()];
}
