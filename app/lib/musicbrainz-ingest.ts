// Both steps refuse to guess: a wrong release attaches every track to the wrong recording,
// invisibly.
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from './db';
import { forChunks } from './db/chunked';
import { normalizeIsrc } from './isrc';
import {
  mbRecording,
  mbRecordingIsrc,
  mbRecordingWork,
  mbRelease,
  mbReleaseTrack,
  spotifyAlbum,
  spotifyTrack,
  trackRecording,
} from './db/schema';
import {
  ingestRelease,
  ingestWorkTree,
  worksNeedingDetail,
  type ReleaseIngestReport,
} from './musicbrainz-cache';
import {
  findReleaseForAlbum,
  loneTrackFits,
  tracklistAligns,
  type ReleaseMatch,
  type ReleaseMatchFailure,
} from './musicbrainz-matching';
import { requestsSpent, type MusicBrainzSource } from './musicbrainz-source';

export { findReleaseForAlbum, releaseFitsAlbum } from './musicbrainz-matching';
export type {
  AlbumIdentity,
  AlbumTrack,
  ReleaseMatch,
  ReleaseMatchFailure,
} from './musicbrainz-matching';

export type AnchorReport = {
  anchored: number;
  byIsrc: number;
  byPosition: number;
  unanchored: number;
  tracklistAligned: boolean;
  contestedIsrcs: string[];
  // Resolved in the ISRC's favour, but counted: either a mis-attached ISRC or not quite the edition
  // we think.
  isrcPositionDisagreements: number;
  replaced: number;
  // Kept rather than overwritten: a stored anchor is what the reader shows and what contributions
  // may cite.
  conflicts: Array<{
    spotifyTrackId: string;
    held: string;
    heldBy: AnchorEvidence;
    proposed: string;
    proposedBy: AnchorEvidence;
  }>;
};

export type AnchorEvidence = 'isrc' | 'release_position';

function evidenceStrength(evidence: AnchorEvidence): number {
  return evidence === 'isrc' ? 2 : 1;
}

function albumTracks(albumId: string) {
  return db
    .select({
      spotifyId: spotifyTrack.spotifyId,
      title: spotifyTrack.title,
      discNumber: spotifyTrack.discNumber,
      trackNumber: spotifyTrack.trackNumber,
      durationMs: spotifyTrack.durationMs,
      isrc: spotifyTrack.isrc,
    })
    .from(spotifyTrack)
    .where(eq(spotifyTrack.spotifyAlbumId, albumId));
}

/** ISRC first; position only when the whole tracklist lines up. Costs no requests. */
export async function anchorAlbumTracks(
  albumId: string,
  releaseMbid: string,
): Promise<AnchorReport> {
  const tracks = await albumTracks(albumId);

  const releaseTracks = await db
    .select({
      medium: mbReleaseTrack.medium,
      position: mbReleaseTrack.position,
      recordingMbid: mbReleaseTrack.recordingMbid,
      trackLength: mbReleaseTrack.length,
      recordingLength: mbRecording.length,
    })
    .from(mbReleaseTrack)
    .leftJoin(mbRecording, eq(mbRecording.mbid, mbReleaseTrack.recordingMbid))
    .where(eq(mbReleaseTrack.releaseMbid, releaseMbid));

  const byPosition = new Map(
    releaseTracks.map((track) => [`${track.medium}:${track.position}`, track]),
  );

  const aligned = tracklistAligns(
    tracks,
    releaseTracks.map((track) => ({
      medium: track.medium,
      position: track.position,
      length: track.trackLength ?? track.recordingLength,
    })),
  );

  const isrcs = tracks.flatMap((track) => (track.isrc ? [track.isrc] : []));
  const isrcRows = await forChunks(isrcs, (chunk) =>
    db
      .select({ isrc: mbRecordingIsrc.isrc, recordingMbid: mbRecordingIsrc.recordingMbid })
      .from(mbRecordingIsrc)
      .where(inArray(mbRecordingIsrc.isrc, chunk)),
  );
  const recordingsByIsrc = new Map<string, Set<string>>();
  for (const row of isrcRows) {
    const set = recordingsByIsrc.get(row.isrc) ?? new Set<string>();
    set.add(row.recordingMbid);
    recordingsByIsrc.set(row.isrc, set);
  }

  const report: AnchorReport = {
    anchored: 0,
    byIsrc: 0,
    byPosition: 0,
    unanchored: 0,
    tracklistAligned: aligned,
    contestedIsrcs: [],
    isrcPositionDisagreements: 0,
    replaced: 0,
    conflicts: [],
  };

  const rows: {
    spotifyTrackId: string;
    recordingMbid: string;
    isrc: string | null;
    matchedBy: 'isrc' | 'release_position';
  }[] = [];

  for (const track of tracks) {
    const claimants = track.isrc ? recordingsByIsrc.get(track.isrc) : undefined;
    const positional = byPosition.get(`${track.discNumber}:${track.trackNumber}`);

    if (claimants && claimants.size === 1) {
      const [recordingMbid] = [...claimants];
      if (positional && positional.recordingMbid !== recordingMbid) {
        report.isrcPositionDisagreements++;
      }
      rows.push({
        spotifyTrackId: track.spotifyId,
        recordingMbid,
        isrc: track.isrc,
        matchedBy: 'isrc',
      });
      report.byIsrc++;
      continue;
    }

    // One ISRC on two recordings is an upstream error, not a tie to break.
    if (claimants && claimants.size > 1 && track.isrc) {
      report.contestedIsrcs.push(track.isrc);
    }

    // A whole aligned tracklist corroborates each position, so the tolerance can be generous; a
    // fragment (a liked track from a box set) stands alone and must agree closely.
    const positionHolds = aligned
      ? Boolean(positional)
      : loneTrackFits(
          track,
          positional && {
            medium: positional.medium,
            position: positional.position,
            length: positional.trackLength ?? positional.recordingLength,
          },
        );

    if (positional && positionHolds) {
      rows.push({
        spotifyTrackId: track.spotifyId,
        recordingMbid: positional.recordingMbid,
        isrc: track.isrc,
        matchedBy: 'release_position',
      });
      report.byPosition++;
      continue;
    }

    report.unanchored++;
  }

  report.anchored = await writeAnchors(rows, report);
  return report;
}

// Evidence has to improve: repointing to a different recording needs strictly stronger evidence,
// else the conflict is reported. Otherwise a backfill could quietly repoint correct anchors.
async function writeAnchors(
  rows: Array<{
    spotifyTrackId: string;
    recordingMbid: string;
    isrc: string | null;
    matchedBy: AnchorEvidence;
  }>,
  report: AnchorReport,
): Promise<number> {
  if (rows.length === 0) return 0;
  const existing = new Map(
    (
      await forChunks(
        rows.map((row) => row.spotifyTrackId),
        (chunk) =>
          db
            .select({
              spotifyTrackId: trackRecording.spotifyTrackId,
              recordingMbid: trackRecording.recordingMbid,
              isrc: trackRecording.isrc,
              matchedBy: trackRecording.matchedBy,
            })
            .from(trackRecording)
            .where(inArray(trackRecording.spotifyTrackId, chunk)),
      )
    ).map((row) => [row.spotifyTrackId, row]),
  );

  let written = 0;
  for (const row of rows) {
    const held = existing.get(row.spotifyTrackId);
    // Already says exactly this: rewriting it would only move `matched_at`.
    if (
      held &&
      held.recordingMbid === row.recordingMbid &&
      held.matchedBy === row.matchedBy &&
      held.isrc === row.isrc
    ) {
      written++;
      continue;
    }
    if (held && held.recordingMbid !== row.recordingMbid) {
      if (evidenceStrength(row.matchedBy) <= evidenceStrength(held.matchedBy)) {
        report.conflicts.push({
          spotifyTrackId: row.spotifyTrackId,
          held: held.recordingMbid,
          heldBy: held.matchedBy,
          proposed: row.recordingMbid,
          proposedBy: row.matchedBy,
        });
        continue;
      }
      report.replaced++;
    }
    await db
      .insert(trackRecording)
      .values({ ...row, matchedAt: new Date() })
      .onConflictDoUpdate({
        target: trackRecording.spotifyTrackId,
        set: { ...row, matchedAt: new Date() },
      });
    written++;
  }
  return written;
}

export type AlbumIngestReport = {
  albumId: string;
  releaseMbid: string | null;
  matchedBy: ReleaseMatch['matchedBy'] | null;
  reason: ReleaseMatchFailure['reason'] | null;
  requests: number;
  release: ReleaseIngestReport | null;
  anchors: AnchorReport | null;
};

export async function ingestAlbum(
  source: MusicBrainzSource,
  albumId: string,
  options: { fetchWorks?: boolean } = {},
): Promise<AlbumIngestReport> {
  const [album] = await db
    .select({
      spotifyId: spotifyAlbum.spotifyId,
      title: spotifyAlbum.title,
      upc: spotifyAlbum.upc,
      mbReleaseId: spotifyAlbum.mbReleaseId,
      mbReleaseCandidates: spotifyAlbum.mbReleaseCandidates,
    })
    .from(spotifyAlbum)
    .where(eq(spotifyAlbum.spotifyId, albumId));
  if (!album) throw new Error(`Unknown album ${albumId}`);

  const tracks = await albumTracks(albumId);

  const match = await findReleaseForAlbum(source, album, tracks);
  let requests = match.requests;

  if (match.releaseMbid === null) {
    await db
      .update(spotifyAlbum)
      .set({ mbCheckedAt: new Date(), mbReleaseCandidates: match.candidates.length })
      .where(eq(spotifyAlbum.spotifyId, albumId));
    return {
      albumId,
      releaseMbid: null,
      matchedBy: null,
      reason: match.reason,
      requests,
      release: null,
      anchors: null,
    };
  }

  // Works are read after anchoring, so a box set we own one track of costs one request rather than
  // a hundred.
  const release = await ingestRelease(source, match.releaseMbid, { fetchWorks: false });
  requests += release.requests;

  if (!release.found) {
    return {
      albumId,
      releaseMbid: match.releaseMbid,
      matchedBy: match.matchedBy,
      reason: 'not_found',
      requests,
      release,
      anchors: null,
    };
  }

  // A release already recorded stays as it was, with the evidence it was first matched on.
  if (match.matchedBy !== 'known' || album.mbReleaseCandidates !== 1) {
    await db
      .update(spotifyAlbum)
      .set({
        mbReleaseId: match.releaseMbid,
        ...(match.matchedBy === 'known' ? {} : { mbReleaseMatchedBy: match.matchedBy }),
        mbCheckedAt: new Date(),
        mbReleaseCandidates: 1,
      })
      .where(eq(spotifyAlbum.spotifyId, albumId));
  }

  const anchors = await anchorAlbumTracks(albumId, match.releaseMbid);

  if (options.fetchWorks !== false) {
    const reachable = await worksReachedByAlbum(albumId);
    for (const workMbid of await worksNeedingDetail(reachable)) {
      const { requests: spent } = await ingestWorkTree(source, workMbid);
      requests += spent;
      if (spent > 0) release.worksFetched++;
    }
  }

  return {
    albumId,
    releaseMbid: match.releaseMbid,
    matchedBy: match.matchedBy,
    reason: null,
    requests,
    release,
    anchors,
  };
}

// An ISRC resolves without a release, reaching albums MusicBrainz lacks. Batched twenty at a time:
// long Lucene OR queries make the server answer 503.
export async function anchorTracksByIsrc(
  source: MusicBrainzSource,
  options: { limit?: number; albumId?: string } = {},
): Promise<{ anchored: number; requests: number; searched: number }> {
  const rows = await db
    .select({ spotifyId: spotifyTrack.spotifyId, isrc: spotifyTrack.isrc })
    .from(spotifyTrack)
    .where(
      and(
        isNotNull(spotifyTrack.isrc),
        options.albumId ? eq(spotifyTrack.spotifyAlbumId, options.albumId) : undefined,
        sql`not exists (select 1 from ${trackRecording} where ${trackRecording.spotifyTrackId} = ${spotifyTrack.spotifyId})`,
      ),
    )
    .limit(options.limit ?? 500);

  const byIsrc = new Map<string, string[]>();
  for (const row of rows) {
    const isrc = normalizeIsrc(row.isrc);
    if (!isrc) continue;
    byIsrc.set(isrc, [...(byIsrc.get(isrc) ?? []), row.spotifyId]);
  }

  const isrcs = [...byIsrc.keys()];
  let requests = 0;
  let anchored = 0;

  for (let i = 0; i < isrcs.length; i += 20) {
    const batch = isrcs.slice(i, i + 20);
    const found = await source.recordingsByIsrc(batch);
    requests += requestsSpent(found);

    for (const [isrc, recordingMbid] of found) {
      // Remember the mapping so a later lookup of the same ISRC is a join.
      await db.insert(mbRecordingIsrc).values({ isrc, recordingMbid }).onConflictDoNothing();

      // A stub, so the anchor points at something cached; the stub queues the full lookup.
      await db
        .insert(mbRecording)
        .values({ mbid: recordingMbid, title: '', detail: 'stub' })
        .onConflictDoNothing();

      for (const spotifyTrackId of byIsrc.get(isrc) ?? []) {
        await db
          .insert(trackRecording)
          .values({ spotifyTrackId, recordingMbid, isrc, matchedBy: 'isrc', matchedAt: new Date() })
          .onConflictDoNothing();
        anchored++;
      }
    }
  }

  return { anchored, requests, searched: isrcs.length };
}

async function worksReachedByAlbum(albumId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workMbid: mbRecordingWork.workMbid })
    .from(trackRecording)
    .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId))
    .innerJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, trackRecording.recordingMbid))
    .where(eq(spotifyTrack.spotifyAlbumId, albumId));
  return rows.map((row) => row.workMbid);
}

// Albums with a known release first (one request each), so an interrupted run spent budget where it
// pays off. Then never-checked albums, then the oldest check: MusicBrainz grows.
export async function albumsNeedingIngest(limit = 25): Promise<string[]> {
  const rows = await db
    .select({ spotifyId: spotifyAlbum.spotifyId })
    .from(spotifyAlbum)
    .where(
      sql`not exists (select 1 from ${mbRelease} where ${mbRelease.mbid} = ${spotifyAlbum.mbReleaseId})`,
    )
    .orderBy(
      sql`${spotifyAlbum.mbReleaseId} is null`,
      sql`${spotifyAlbum.mbCheckedAt} is not null`,
      spotifyAlbum.mbCheckedAt,
    )
    .limit(limit);
  return rows.map((row) => row.spotifyId);
}

/** `includeAnchored`: anchoring is free, so re-running it is how a rule change reaches old rows. */
export async function albumsNeedingAnchoring(
  limit = 100,
  includeAnchored = false,
): Promise<{ albumId: string; releaseMbid: string }[]> {
  const unanchored = sql`not exists (
    select 1 from ${trackRecording}
    join ${spotifyTrack} on ${spotifyTrack.spotifyId} = ${trackRecording.spotifyTrackId}
    where ${spotifyTrack.spotifyAlbumId} = ${spotifyAlbum.spotifyId}
  )`;

  const rows = await db
    .select({ albumId: spotifyAlbum.spotifyId, releaseMbid: spotifyAlbum.mbReleaseId })
    .from(spotifyAlbum)
    .where(
      and(
        isNotNull(spotifyAlbum.mbReleaseId),
        sql`exists (select 1 from ${mbReleaseTrack} where ${mbReleaseTrack.releaseMbid} = ${spotifyAlbum.mbReleaseId})`,
        includeAnchored ? undefined : unanchored,
      ),
    )
    .limit(limit);
  return rows.flatMap((row) => (row.releaseMbid ? [{ ...row, releaseMbid: row.releaseMbid }] : []));
}
