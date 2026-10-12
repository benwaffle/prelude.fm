import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  mbArtist,
  mbRecording,
  mbRecordingWork,
  mbRelease,
  mbReleaseTrack,
  mbWork,
  mbWorkCatalogue,
  spotifyAlbum,
  spotifyTrack,
  trackRecording,
} from '../db/schema';
import { filmScoreExclusions } from '../film-score-exclusions';
import { within, without } from './scope';

// Sibling recordings may suggest works; they are candidates for a human to verify, not inferred
// links.
export type WorkRelationshipGap = {
  recordingMbid: string;
  recordingTitle: string;
  albumId: string;
  /** Null when the album's release is not cached; the recording is still actionable. */
  releaseMbid: string | null;
  albumTitle: string;
  tracks: number;
  candidates: WorkCandidate[];
};

export type WorkRelationshipGapRow = Omit<WorkRelationshipGap, 'candidates'>;

export type WorkCandidate = {
  workMbid: string;
  title: string;
  type: string | null;
  composerMbid: string | null;
  composerName: string | null;
  catalogues: { system: string; number: string }[];
  evidence: 'same_release_recording'[];
};

export async function workRelationshipGaps(
  scope: { recordingMbids?: readonly string[] } = {},
): Promise<WorkRelationshipGapRow[]> {
  const film = await filmScoreExclusions();
  return db
    .select({
      recordingMbid: trackRecording.recordingMbid,
      recordingTitle: mbRecording.title,
      albumId: spotifyAlbum.spotifyId,
      releaseMbid: mbRelease.mbid,
      albumTitle: spotifyAlbum.title,
      tracks: sql<number>`count(*)`,
    })
    .from(trackRecording)
    .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId))
    .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
    .innerJoin(mbRecording, eq(mbRecording.mbid, trackRecording.recordingMbid))
    .leftJoin(mbRelease, eq(mbRelease.mbid, spotifyAlbum.mbReleaseId))
    .where(
      and(
        within(trackRecording.recordingMbid, scope.recordingMbids),
        without(spotifyTrack.spotifyId, film.trackIds),
        sql`not exists (
          select 1 from mb_recording_work
          where mb_recording_work.recording_mbid = ${trackRecording.recordingMbid}
        )`,
      ),
    )
    .groupBy(trackRecording.recordingMbid)
    .orderBy(sql`count(*) desc`, trackRecording.recordingMbid);
}

export async function withWorkCandidates(
  gaps: WorkRelationshipGapRow[],
): Promise<WorkRelationshipGap[]> {
  const releaseMbids = [
    ...new Set(gaps.map((gap) => gap.releaseMbid).filter((id): id is string => !!id)),
  ];
  if (releaseMbids.length === 0) return gaps.map((gap) => ({ ...gap, candidates: [] }));
  const siblings = await db
    .selectDistinct({
      releaseMbid: mbReleaseTrack.releaseMbid,
      recordingMbid: mbReleaseTrack.recordingMbid,
      workMbid: mbWork.mbid,
      title: mbWork.title,
      type: mbWork.type,
      composerMbid: mbWork.composerMbid,
      composerName: mbArtist.name,
    })
    .from(mbReleaseTrack)
    .innerJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, mbReleaseTrack.recordingMbid))
    .innerJoin(mbWork, eq(mbWork.mbid, mbRecordingWork.workMbid))
    .leftJoin(mbArtist, eq(mbArtist.mbid, mbWork.composerMbid))
    .where(inArray(mbReleaseTrack.releaseMbid, releaseMbids));
  const workMbids = [...new Set(siblings.map((row) => row.workMbid))];
  const catalogues =
    workMbids.length === 0
      ? []
      : await db
          .select({
            workMbid: mbWorkCatalogue.workMbid,
            system: mbWorkCatalogue.system,
            number: mbWorkCatalogue.number,
          })
          .from(mbWorkCatalogue)
          .where(inArray(mbWorkCatalogue.workMbid, workMbids));
  return gaps.map((gap) => {
    const seen = new Set<string>();
    const candidates: WorkCandidate[] = [];
    for (const row of siblings) {
      if (
        row.releaseMbid !== gap.releaseMbid ||
        row.recordingMbid === gap.recordingMbid ||
        seen.has(row.workMbid)
      )
        continue;
      seen.add(row.workMbid);
      candidates.push({
        workMbid: row.workMbid,
        title: row.title,
        type: row.type,
        composerMbid: row.composerMbid,
        composerName: row.composerName,
        catalogues: catalogues
          .filter((catalogue) => catalogue.workMbid === row.workMbid)
          .map(({ system, number }) => ({ system, number })),
        evidence: ['same_release_recording'],
      });
    }
    candidates.sort((a, b) => a.title.localeCompare(b.title));
    return { ...gap, candidates };
  });
}
