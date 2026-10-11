/**
 * Measures what landed on MusicBrainz for a release somebody added through
 * Harmony, against the Spotify seed, and stores the result.
 *
 * Reads live MusicBrainz on the `interactive` channel: the release itself,
 * one browse for its release group, a search per twenty recordings for
 * where else they appear, and — only for recordings that search cannot see
 * yet — one browse each, up to `ORIGIN_BROWSE_LIMIT`.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { mbRecordingWork, mbWork, spotifyAlbum, trackRecording, spotifyTrack } from './db/schema';
import { createMbSession, type MbSession } from './musicbrainz-session';
import { readMissingReleases, writeMissingRelease } from './missing-release-store';
import {
  compareRelease,
  type LandedArtist,
  type LandedRelease,
  type RecordingOrigin,
  type ReleaseCorrectionRecord,
} from './release-corrections';
import { precheckHits } from './release-precheck';
import { loadReleaseSeed } from './release-precheck-run';
import { preparedSeedOf } from './release-seeding-run';
import { seedPlanBaseline } from './release-seeding';

export { correctionRecords, type CorrectionRow } from './missing-release-store';

const SEARCH_CHUNK = 20;
/** Recordings browsed one at a time when search cannot place them; the rest stay unknown. */
export const ORIGIN_BROWSE_LIMIT = 150;

const landedArtists = (credit: { artistId: string; name: string }[]): LandedArtist[] =>
  credit.map((part) => ({ mbid: part.artistId, name: part.name }));

/** The release as it now stands on MusicBrainz, or null if it does not exist. */
async function fetchLandedRelease(
  mb: MbSession,
  releaseMbid: string,
): Promise<LandedRelease | null> {
  const release = await mb.release(releaseMbid);
  if (!release) return null;
  const group = release.releaseGroup;
  let otherReleases: number | null = null;
  if (group) {
    try {
      const browse = await mb.get<{ 'release-count'?: number }>(
        `/release?release-group=${group.id}&limit=1&fmt=json`,
      );
      if (typeof browse?.['release-count'] === 'number') {
        otherReleases = Math.max(0, browse['release-count'] - 1);
      }
    } catch {
      otherReleases = null;
    }
  }
  return {
    mbid: release.id,
    title: release.title,
    artists: landedArtists(release.artistCredit),
    releaseGroup: { mbid: group?.id ?? '', title: group?.title ?? '', otherReleases },
    media: release.media,
    tracks: release.tracks.map((track) => ({
      medium: track.medium,
      position: track.position,
      title: track.title,
      lengthMs: track.length,
      artists: landedArtists(track.artistCredit),
      recording: {
        mbid: track.recording.id,
        title: track.recording.title,
        artists: landedArtists(track.recording.artistCredit),
        isrcs: track.recording.isrcs,
      },
    })),
  };
}

/**
 * Whether each recording on the release existed before it.
 *
 * A recording the pre-check found by ISRC existed already. Otherwise a
 * recording on any other release is reused and one on this release alone was
 * created with it. Search is tried first because it answers twenty at once;
 * a recording it has not indexed yet — typically one created minutes ago —
 * is browsed directly.
 */
async function recordingOrigins(
  mb: MbSession,
  releaseMbid: string,
  recordingMbids: string[],
  knownBefore: Set<string>,
): Promise<Map<string, RecordingOrigin>> {
  const origins = new Map<string, RecordingOrigin>();
  const pending = [...new Set(recordingMbids)].filter((mbid) => {
    if (knownBefore.has(mbid)) origins.set(mbid, 'reused');
    return !knownBefore.has(mbid);
  });

  const unseen: string[] = [];
  for (let index = 0; index < pending.length; index += SEARCH_CHUNK) {
    const chunk = pending.slice(index, index + SEARCH_CHUNK);
    let found: { id: string; releases?: { id: string }[] }[] = [];
    try {
      const result = await mb.get<{ recordings?: { id: string; releases?: { id: string }[] }[] }>(
        `/recording?query=${encodeURIComponent(chunk.map((mbid) => `rid:${mbid}`).join(' OR '))}&fmt=json&limit=100`,
      );
      found = result?.recordings ?? [];
    } catch {
      found = [];
    }
    const byId = new Map(found.map((recording) => [recording.id, recording]));
    for (const mbid of chunk) {
      const recording = byId.get(mbid);
      const elsewhere = recording?.releases?.some((release) => release.id !== releaseMbid);
      if (elsewhere) origins.set(mbid, 'reused');
      else unseen.push(mbid);
    }
  }

  // Search saying "only this release" may just be stale, so those are
  // browsed as well: the browse reads the database, not the index.
  for (const [index, mbid] of unseen.entries()) {
    if (index >= ORIGIN_BROWSE_LIMIT) {
      origins.set(mbid, 'unknown');
      continue;
    }
    try {
      const browse = await mb.get<{ 'release-count'?: number }>(
        `/release?recording=${mbid}&limit=1&fmt=json`,
      );
      const count = browse?.['release-count'];
      origins.set(
        mbid,
        typeof count !== 'number' || count === 0 ? 'unknown' : count > 1 ? 'reused' : 'created',
      );
    } catch {
      origins.set(mbid, 'unknown');
    }
  }
  return origins;
}

/**
 * Distinct composers we can identify for the release: credited artists who
 * compose works in our cache, and composers of the works its recordings
 * perform. Null when there are none — not the same as "one".
 */
async function composerCount(albumId: string, landed: LandedRelease): Promise<number | null> {
  const credited = [
    ...new Set([
      ...landed.artists.map((artist) => artist.mbid),
      ...landed.tracks.flatMap((track) => [
        ...track.artists.map((artist) => artist.mbid),
        ...track.recording.artists.map((artist) => artist.mbid),
      ]),
    ]),
  ];
  const [composing, worked] = await Promise.all([
    credited.length === 0
      ? []
      : db
          .select({ mbid: mbWork.composerMbid })
          .from(mbWork)
          .where(inArray(mbWork.composerMbid, credited))
          .groupBy(mbWork.composerMbid),
    db
      .select({ mbid: mbWork.composerMbid })
      .from(spotifyTrack)
      .innerJoin(trackRecording, eq(trackRecording.spotifyTrackId, spotifyTrack.spotifyId))
      .innerJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, trackRecording.recordingMbid))
      .innerJoin(mbWork, eq(mbWork.mbid, mbRecordingWork.workMbid))
      .where(eq(spotifyTrack.spotifyAlbumId, albumId))
      .groupBy(mbWork.composerMbid),
  ]);
  const composers = new Set(
    [...composing, ...worked].flatMap((row) => (row.mbid ? [row.mbid] : [])),
  );
  return composers.size === 0 ? null : composers.size;
}

export class CorrectionMeasureError extends Error {}

/** Which release to measure: the one the album is matched to, or the one confirmed. */
async function releaseFor(
  albumId: string,
  confirmedReleaseMbid: string | null,
): Promise<string | null> {
  const [album] = await db
    .select({ mbReleaseId: spotifyAlbum.mbReleaseId })
    .from(spotifyAlbum)
    .where(eq(spotifyAlbum.spotifyId, albumId));
  return album?.mbReleaseId ?? confirmedReleaseMbid;
}

/** Measure the album's landed release against its seed and store the record. */
export async function measureReleaseCorrection(
  albumId: string,
  confirmedReleaseMbid: string | null,
): Promise<ReleaseCorrectionRecord> {
  const releaseMbid = await releaseFor(albumId, confirmedReleaseMbid);
  if (!releaseMbid) {
    throw new CorrectionMeasureError(
      'No release to measure yet: confirm with the new release MBID, or Recheck once it is found.',
    );
  }
  const mb = createMbSession('interactive');
  const landed = await fetchLandedRelease(mb, releaseMbid);
  if (!landed) throw new CorrectionMeasureError(`MusicBrainz has no release ${releaseMbid}`);

  const stored = (await readMissingReleases([albumId])).get(albumId) ?? {};
  const precheck = stored.precheck?.value;
  const prepared = preparedSeedOf(stored);
  // When our own seed was opened on MusicBrainz, that form is what the person
  // corrected; otherwise it is the Spotify album Harmony reads.
  const usedSeed = prepared?.seededPlan ?? null;
  const seed = usedSeed
    ? seedPlanBaseline(usedSeed)
    : (precheck?.seed ?? (await loadReleaseSeed(albumId)));
  const baselineSource = usedSeed ? 'prelude-seed' : precheck ? 'precheck' : seed.source;
  // Recordings we found before the release existed: by ISRC, or pre-filled
  // into the seed (which only ever names existing recordings).
  const knownBefore = new Set([
    ...(precheck ? precheckHits(precheck.isrcs) : []).map((hit) => hit.recordingMbid),
    ...(prepared?.plan.tracks ?? []).flatMap((track) =>
      track.recording.state === 'matched' ? [track.recording.recordingMbid] : [],
    ),
  ]);
  const origins = await recordingOrigins(
    mb,
    releaseMbid,
    landed.tracks.map((track) => track.recording.mbid),
    knownBefore,
  );
  const artistMbids = new Map(
    (precheck?.artists ?? []).flatMap((artist) =>
      artist.spotifyId && artist.match.state === 'linked'
        ? [[artist.spotifyId, artist.match.artist.mbid] as const]
        : [],
    ),
  );
  const record = compareRelease({
    seed,
    baselineSource,
    landed,
    origins,
    artistMbids,
    seededReleaseGroup: usedSeed?.releaseGroupMbid ?? null,
    composers: await composerCount(albumId, landed),
  });

  await writeMissingRelease(albumId, 'correction', record, mb.requests);
  return record;
}
