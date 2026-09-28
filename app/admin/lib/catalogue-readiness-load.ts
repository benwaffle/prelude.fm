import { inArray } from 'drizzle-orm';
import { db, type DatabaseExecutor } from '@/lib/db';
import { mbSubmission, spotifyTrack } from '@/lib/db/schema';
import {
  readinessFunnel,
  readinessTracksFrom,
  tracksBlockedOnReleaseByAlbum,
  type ReadinessFunnel,
  type ReadinessSubmissions,
} from '@/lib/catalogue-readiness';
import { projectMusicBrainzLibrary } from '@/lib/musicbrainz-library';
import { loadMusicBrainzLibraryFacts } from '@/app/actions/library-musicbrainz';

/**
 * The readiness funnel over every Spotify track we hold, read through the
 * same facts loader and projection the player uses.
 */
export async function loadReadinessFunnel(
  database: DatabaseExecutor = db,
): Promise<ReadinessFunnel> {
  const { tracks, submissions } = await loadReadinessTracks(database);
  return readinessFunnel(tracks, submissions);
}

/**
 * Per missing album, the library tracks adding its release would unblock —
 * the Overview's own count, so the Inbox order and the funnel agree.
 */
export async function loadTracksBlockedOnRelease(
  database: DatabaseExecutor = db,
): Promise<Map<string, number>> {
  const { tracks, submissions } = await loadReadinessTracks(database);
  return tracksBlockedOnReleaseByAlbum(tracks, submissions);
}

async function loadReadinessTracks(database: DatabaseExecutor) {
  const trackRows = await database
    .select({ spotifyId: spotifyTrack.spotifyId, isrc: spotifyTrack.isrc })
    .from(spotifyTrack);
  const facts = await loadMusicBrainzLibraryFacts(
    trackRows.map((row) => row.spotifyId),
    database,
  );
  const tracks = readinessTracksFrom(
    facts,
    projectMusicBrainzLibrary(facts),
    new Map(trackRows.map((row) => [row.spotifyId, row.isrc])),
  );
  return { tracks, submissions: await loadReadinessSubmissions(database) };
}

/**
 * Submissions MusicBrainz has not rejected and the cache does not reflect
 * yet. An applied edit still counts until our next read picks it up: until
 * then the track is waiting, not outstanding.
 */
async function loadReadinessSubmissions(database: DatabaseExecutor): Promise<ReadinessSubmissions> {
  const rows = await database
    .select({
      kind: mbSubmission.kind,
      subject: mbSubmission.subject,
      targetMbid: mbSubmission.targetMbid,
      value: mbSubmission.value,
      evidence: mbSubmission.evidence,
    })
    .from(mbSubmission)
    .where(inArray(mbSubmission.outcome, ['pending', 'applied']));
  const submissions: ReadinessSubmissions = {
    releaseAlbums: new Set(),
    tracklistReportAlbums: new Set(),
    contestedReportIsrcs: new Set(),
    workLinkRecordings: new Set(),
  };
  for (const row of rows) {
    if (row.kind === 'release') submissions.releaseAlbums.add(row.subject);
    else if (row.kind === 'work_relationship' && row.targetMbid) {
      submissions.workLinkRecordings.add(row.targetMbid);
    } else if (row.kind === 'error' && row.value) {
      const problem = row.evidence?.problem;
      if (problem === 'misaligned_tracklist') submissions.tracklistReportAlbums.add(row.value);
      else if (problem === 'contested_isrc') {
        submissions.contestedReportIsrcs.add(row.value.toUpperCase());
      }
    }
  }
  return submissions;
}
