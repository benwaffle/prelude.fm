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
import { db, type DatabaseExecutor } from './db';
import {
  mbRecordingWork,
  mbReleaseCorrection,
  mbWork,
  spotifyAlbum,
  trackRecording,
  spotifyTrack,
} from './db/schema';
import { mbGet } from './musicbrainz';
import type { MusicBrainzChannel } from './musicbrainz-gateway';
import {
  compareRelease,
  type LandedArtist,
  type LandedRelease,
  type RecordingOrigin,
  type ReleaseCorrectionRecord,
} from './release-corrections';
import { cachedReleasePrechecks, loadReleaseSeed } from './release-precheck-run';
import { cachedReleaseSeeds } from './release-seeding-run';
import { seedPlanBaseline } from './release-seeding';

const CHANNEL: MusicBrainzChannel = 'interactive';
const SEARCH_CHUNK = 20;
/** Recordings browsed one at a time when search cannot place them; the rest stay unknown. */
export const ORIGIN_BROWSE_LIMIT = 150;

type RawCredit = { name?: string; artist?: { id: string; name: string } }[];
const artistsOf = (credit: RawCredit | undefined): LandedArtist[] =>
  (credit ?? []).flatMap((part) =>
    part.artist ? [{ mbid: part.artist.id, name: part.name ?? part.artist.name }] : [],
  );

type RawRelease = {
  id: string;
  title: string;
  'artist-credit'?: RawCredit;
  'release-group'?: { id: string; title: string };
  media?: {
    position?: number;
    tracks?: {
      position?: number;
      title?: string;
      length?: number | null;
      'artist-credit'?: RawCredit;
      recording?: {
        id: string;
        title?: string;
        isrcs?: string[];
        'artist-credit'?: RawCredit;
      };
    }[];
  }[];
};

/** The release as it now stands on MusicBrainz, or null if it does not exist. */
export async function fetchLandedRelease(releaseMbid: string): Promise<LandedRelease | null> {
  const raw = await mbGet<RawRelease>(
    `/release/${releaseMbid}?inc=recordings+artist-credits+release-groups+isrcs&fmt=json`,
    CHANNEL,
  );
  if (!raw) return null;
  const group = raw['release-group'];
  let otherReleases: number | null = null;
  if (group) {
    try {
      const browse = await mbGet<{ 'release-count'?: number }>(
        `/release?release-group=${group.id}&limit=1&fmt=json`,
        CHANNEL,
      );
      if (typeof browse?.['release-count'] === 'number') {
        otherReleases = Math.max(0, browse['release-count'] - 1);
      }
    } catch {
      otherReleases = null;
    }
  }
  return {
    mbid: raw.id,
    title: raw.title,
    artists: artistsOf(raw['artist-credit']),
    releaseGroup: { mbid: group?.id ?? '', title: group?.title ?? '', otherReleases },
    media: raw.media?.length ?? 0,
    tracks: (raw.media ?? []).flatMap((medium, mediumIndex) =>
      (medium.tracks ?? []).flatMap((track, trackIndex) =>
        track.recording
          ? [
              {
                medium: medium.position ?? mediumIndex + 1,
                position: track.position ?? trackIndex + 1,
                title: track.title ?? track.recording.title ?? '',
                lengthMs: track.length ?? null,
                artists: artistsOf(track['artist-credit']),
                recording: {
                  mbid: track.recording.id,
                  title: track.recording.title ?? '',
                  artists: artistsOf(track.recording['artist-credit']),
                  isrcs: track.recording.isrcs ?? [],
                },
              },
            ]
          : [],
      ),
    ),
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
export async function recordingOrigins(
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
      const result = await mbGet<{ recordings?: { id: string; releases?: { id: string }[] }[] }>(
        `/recording?query=${encodeURIComponent(chunk.map((mbid) => `rid:${mbid}`).join(' OR '))}&fmt=json&limit=100`,
        CHANNEL,
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
      const browse = await mbGet<{ 'release-count'?: number }>(
        `/release?recording=${mbid}&limit=1&fmt=json`,
        CHANNEL,
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
async function composerCount(
  albumId: string,
  landed: LandedRelease,
  database: DatabaseExecutor,
): Promise<number | null> {
  const credited = [
    ...new Set([
      ...landed.artists.map((artist) => artist.mbid),
      ...landed.tracks.flatMap((track) => [
        ...track.artists.map((artist) => artist.mbid),
        ...track.recording.artists.map((artist) => artist.mbid),
      ]),
    ]),
  ];
  const composers = new Set<string>();
  if (credited.length > 0) {
    const rows = await database
      .select({ mbid: mbWork.composerMbid })
      .from(mbWork)
      .where(inArray(mbWork.composerMbid, credited))
      .groupBy(mbWork.composerMbid);
    for (const row of rows) if (row.mbid) composers.add(row.mbid);
  }
  const worked = await database
    .select({ mbid: mbWork.composerMbid })
    .from(spotifyTrack)
    .innerJoin(trackRecording, eq(trackRecording.spotifyTrackId, spotifyTrack.spotifyId))
    .innerJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, trackRecording.recordingMbid))
    .innerJoin(mbWork, eq(mbWork.mbid, mbRecordingWork.workMbid))
    .where(eq(spotifyTrack.spotifyAlbumId, albumId))
    .groupBy(mbWork.composerMbid);
  for (const row of worked) if (row.mbid) composers.add(row.mbid);
  return composers.size === 0 ? null : composers.size;
}

export class CorrectionMeasureError extends Error {}

/** Which release to measure: the one the album is matched to, or the one confirmed. */
async function releaseFor(
  albumId: string,
  confirmedReleaseMbid: string | null,
  database: DatabaseExecutor,
): Promise<string | null> {
  const [album] = await database
    .select({ mbReleaseId: spotifyAlbum.mbReleaseId })
    .from(spotifyAlbum)
    .where(eq(spotifyAlbum.spotifyId, albumId));
  return album?.mbReleaseId ?? confirmedReleaseMbid;
}

/** Measure the album's landed release against its seed and store the record. */
export async function measureReleaseCorrection(
  albumId: string,
  confirmedReleaseMbid: string | null,
  database: DatabaseExecutor = db,
): Promise<ReleaseCorrectionRecord> {
  const releaseMbid = await releaseFor(albumId, confirmedReleaseMbid, database);
  if (!releaseMbid) {
    throw new CorrectionMeasureError(
      'No release to measure yet: confirm with the new release MBID, or Recheck once it is found.',
    );
  }
  const landed = await fetchLandedRelease(releaseMbid);
  if (!landed) throw new CorrectionMeasureError(`MusicBrainz has no release ${releaseMbid}`);

  const cached = (await cachedReleasePrechecks([albumId], database)).get(albumId);
  // When our own seed was opened on MusicBrainz, that form is what the person
  // corrected; otherwise it is the Spotify album Harmony reads.
  const seeded = (await cachedReleaseSeeds([albumId], database)).get(albumId);
  const usedSeed = seeded?.seededAt ? seeded.plan : null;
  const seed = usedSeed
    ? seedPlanBaseline(usedSeed)
    : (cached?.result.seed ?? (await loadReleaseSeed(albumId, database)));
  const baselineSource = usedSeed ? 'prelude-seed' : cached ? 'precheck' : seed.source;
  // Recordings we found before the release existed: by ISRC, or pre-filled
  // into the seed (which only ever names existing recordings).
  const knownBefore = new Set([
    ...(cached?.result.isrcs.state === 'done'
      ? cached.result.isrcs.value.hits.map((hit) => hit.recordingMbid)
      : []),
    ...(seeded?.plan.tracks ?? []).flatMap((track) =>
      track.recording.state === 'matched' ? [track.recording.recordingMbid] : [],
    ),
  ]);
  const origins = await recordingOrigins(
    releaseMbid,
    landed.tracks.map((track) => track.recording.mbid),
    knownBefore,
  );
  const artistMbids = new Map(
    (cached?.result.artists ?? []).flatMap((artist) =>
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
    composers: await composerCount(albumId, landed, database),
  });

  const values = {
    releaseMbid,
    kind: record.kind,
    corrections: record.corrections.length,
    incomplete: record.incomplete.length > 0,
    record,
    measuredAt: new Date(),
  };
  await database
    .insert(mbReleaseCorrection)
    .values({ spotifyAlbumId: albumId, ...values })
    .onConflictDoUpdate({ target: mbReleaseCorrection.spotifyAlbumId, set: values });
  return record;
}

export type CorrectionRow = {
  albumId: string;
  albumTitle: string | null;
  measuredAt: Date;
  record: ReleaseCorrectionRecord;
};

/** Every stored correction record, newest first. */
export async function correctionRecords(database: DatabaseExecutor = db): Promise<CorrectionRow[]> {
  const rows = await database
    .select({
      albumId: mbReleaseCorrection.spotifyAlbumId,
      albumTitle: spotifyAlbum.title,
      measuredAt: mbReleaseCorrection.measuredAt,
      record: mbReleaseCorrection.record,
    })
    .from(mbReleaseCorrection)
    .leftJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, mbReleaseCorrection.spotifyAlbumId));
  return rows.sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime());
}
