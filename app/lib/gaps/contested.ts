import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  judgeContestedIsrc,
  type ContestedClaimant,
  type ContestedIsrcVerdict,
} from '../contested-isrc-verdict';
import { db } from '../db';
import { forChunks } from '../db/chunked';
import {
  mbRecording,
  mbRecordingIsrc,
  mbReleaseTrack,
  spotifyAlbum,
  spotifyTrack,
  trackRecording,
} from '../db/schema';
import { filmScoreExclusions } from '../film-score-exclusions';
import { within, without } from './scope';

// An upstream error that costs us links (Haydn 87's ISRC on a recording of 82); found so we can
// report them.
export type ContestedIsrc = {
  isrc: string;
  recordings: number;
  titles: string;
  recordingMbids: string[];
};

export async function contestedIsrcs(
  scope: { isrcs?: readonly string[] } = {},
): Promise<ContestedIsrc[]> {
  const film = await filmScoreExclusions();
  const groups = await db
    .select({
      isrc: mbRecordingIsrc.isrc,
      recordings: sql<number>`count(*)`,
      titles: sql<string>`group_concat(${mbRecording.title}, ' / ')`,
      recordingMbids: sql<string>`group_concat(${mbRecordingIsrc.recordingMbid})`,
    })
    .from(mbRecordingIsrc)
    .innerJoin(mbRecording, eq(mbRecording.mbid, mbRecordingIsrc.recordingMbid))
    .where(
      and(within(mbRecordingIsrc.isrc, scope.isrcs), without(mbRecordingIsrc.isrc, film.isrcs)),
    )
    .groupBy(mbRecordingIsrc.isrc)
    .having(sql`count(*) > 1`)
    .orderBy(mbRecordingIsrc.isrc);

  return groups.map((group) => ({
    isrc: group.isrc,
    recordings: group.recordings,
    titles: group.titles,
    recordingMbids: [...new Set((group.recordingMbids ?? '').split(',').filter(Boolean))].sort(),
  }));
}

export type ContestedIsrcJudgement = {
  claimants: ContestedClaimant[];
  verdict: ContestedIsrcVerdict;
};

export async function judgeContestedIsrcs(
  rows: ContestedIsrc[],
): Promise<Map<string, ContestedIsrcJudgement>> {
  const isrcs = rows.map((row) => row.isrc);
  const recordingMbids = [...new Set(rows.flatMap((row) => row.recordingMbids))];
  if (isrcs.length === 0) return new Map();

  const [claimantRows, confirmedRows, carrierRows] = await Promise.all([
    forChunks(isrcs, (chunk) =>
      db
        .select({
          isrc: mbRecordingIsrc.isrc,
          recordingMbid: mbRecording.mbid,
          title: mbRecording.title,
          lengthMs: mbRecording.length,
        })
        .from(mbRecordingIsrc)
        .innerJoin(mbRecording, eq(mbRecording.mbid, mbRecordingIsrc.recordingMbid))
        .where(inArray(mbRecordingIsrc.isrc, chunk)),
    ),
    // A code is confirmed as a recording's own when a library track anchored to that recording
    // carries it too.
    forChunks(recordingMbids, (chunk) =>
      db
        .selectDistinct({
          recordingMbid: mbRecordingIsrc.recordingMbid,
          isrc: mbRecordingIsrc.isrc,
        })
        .from(mbRecordingIsrc)
        .innerJoin(trackRecording, eq(trackRecording.recordingMbid, mbRecordingIsrc.recordingMbid))
        .innerJoin(
          spotifyTrack,
          and(
            eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId),
            eq(spotifyTrack.isrc, mbRecordingIsrc.isrc),
          ),
        )
        .where(inArray(mbRecordingIsrc.recordingMbid, chunk)),
    ),
    forChunks(isrcs, (chunk) =>
      db
        .select({
          isrc: spotifyTrack.isrc,
          spotifyTrackId: spotifyTrack.spotifyId,
          durationMs: spotifyTrack.durationMs,
          positionalRecordingMbid: mbReleaseTrack.recordingMbid,
          positionalLengthMs: mbReleaseTrack.length,
        })
        .from(spotifyTrack)
        .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
        .leftJoin(
          mbReleaseTrack,
          and(
            eq(mbReleaseTrack.releaseMbid, spotifyAlbum.mbReleaseId),
            eq(mbReleaseTrack.medium, spotifyTrack.discNumber),
            eq(mbReleaseTrack.position, spotifyTrack.trackNumber),
          ),
        )
        .where(inArray(spotifyTrack.isrc, chunk)),
    ),
  ]);

  const confirmedByRecording = new Map<string, string[]>();
  for (const row of confirmedRows) {
    const list = confirmedByRecording.get(row.recordingMbid) ?? [];
    list.push(row.isrc);
    confirmedByRecording.set(row.recordingMbid, list);
  }

  const judgements = new Map<string, ContestedIsrcJudgement>();
  for (const isrc of isrcs) {
    const claimants = claimantRows
      .filter((row) => row.isrc === isrc)
      .map((row) => ({
        recordingMbid: row.recordingMbid,
        title: row.title,
        lengthMs: row.lengthMs,
        confirmedOtherIsrcs: (confirmedByRecording.get(row.recordingMbid) ?? []).filter(
          (other) => other !== isrc,
        ),
      }))
      .sort((a, b) => a.recordingMbid.localeCompare(b.recordingMbid));
    const carriers = carrierRows
      .filter((row) => row.isrc === isrc)
      .map(({ spotifyTrackId, durationMs, positionalRecordingMbid, positionalLengthMs }) => ({
        spotifyTrackId,
        durationMs,
        positionalRecordingMbid,
        positionalLengthMs,
      }));
    judgements.set(isrc, { claimants, verdict: judgeContestedIsrc(claimants, carriers) });
  }
  return judgements;
}
