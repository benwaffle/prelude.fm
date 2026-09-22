/**
 * Bringing a Spotify album into the MusicBrainz cache.
 *
 * Two questions, in order. Which MusicBrainz release is this album? And which
 * recording is each of its tracks? The first costs requests and is where the
 * judgement lives; the second is a local join once the first is answered.
 *
 * Both refuse to guess. An album that matches two releases equally well is
 * left unmatched, because a wrong release attaches every track on it to the
 * wrong recording, and that error is invisible afterwards — the tracks all
 * have plausible titles and plausible works.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from './db';
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
import type { MusicBrainzSource } from './musicbrainz-source';

export { findReleaseForAlbum, releaseFitsAlbum } from './musicbrainz-matching';
export type {
  AlbumIdentity,
  AlbumTrack,
  ReleaseMatch,
  ReleaseMatchFailure,
} from './musicbrainz-matching';

/* ------------------------------------------------ which recording is it --- */

export type AnchorReport = {
  anchored: number;
  byIsrc: number;
  byPosition: number;
  unanchored: number;
  /** Whether the release's tracklist lines up with the album's, position for position. */
  tracklistAligned: boolean;
  /** ISRCs MusicBrainz maps to more than one recording; an upstream defect worth reporting. */
  contestedIsrcs: string[];
  /**
   * Tracks whose ISRC and whose position name different recordings.
   *
   * Always resolved in the ISRC's favour, but counted rather than swallowed:
   * it means either a mis-attached ISRC upstream or a release that is not
   * quite the edition we think it is, and both are worth knowing about.
   */
  isrcPositionDisagreements: number;
  /** Anchors this pass replaced, because the new evidence is stronger. */
  replaced: number;
  /**
   * Anchors this pass did not make, because one already existed naming a
   * different recording on evidence at least as good.
   *
   * Kept rather than overwritten. A stored anchor is what the reader has
   * been showing and what a contribution may have been filed against;
   * silently repointing it loses both, and the disagreement is the thing
   * worth looking at.
   */
  conflicts: Array<{
    spotifyTrackId: string;
    held: string;
    heldBy: AnchorEvidence;
    proposed: string;
    proposedBy: AnchorEvidence;
  }>;
};

/** How a track was tied to a recording, weakest last. */
export type AnchorEvidence = 'isrc' | 'release_position';

/** An ISRC is the label's own identifier; a position is only as good as the
 *  tracklist it sits in. */
function evidenceStrength(evidence: AnchorEvidence): number {
  return evidence === 'isrc' ? 2 : 1;
}

/**
 * Attach each Spotify track on an album to a MusicBrainz recording.
 *
 * ISRC first — it is the label's own identifier for the recording and needs no
 * corroboration. Then position, but only if the album's whole tracklist lines
 * up with the release's, because a position is only as good as the tracklist
 * it is a position in.
 *
 * Costs no requests: everything it needs is already cached.
 */
export async function anchorAlbumTracks(
  albumId: string,
  releaseMbid: string,
): Promise<AnchorReport> {
  const tracks = await db
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
  const isrcRows = isrcs.length
    ? await db
        .select({ isrc: mbRecordingIsrc.isrc, recordingMbid: mbRecordingIsrc.recordingMbid })
        .from(mbRecordingIsrc)
        .where(inArray(mbRecordingIsrc.isrc, isrcs))
    : [];
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

    // Two different strengths of evidence. When the whole tracklist lines up,
    // the position is corroborated by every other track and a generous
    // tolerance is safe. When we hold a fragment of the release — a liked
    // track from a box set, which most of a personal library is — the
    // position stands alone and the duration has to agree closely.
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

/**
 * Store the anchors this pass worked out, without losing the ones already
 * there.
 *
 * The rule is that evidence has to improve. Re-anchoring the same recording
 * is harmless and keeps the ISRC fresh; pointing a track at a *different*
 * recording is only allowed when the new evidence is strictly stronger than
 * what is stored, and otherwise the existing anchor stands and the
 * disagreement is reported. Anything else means a backfill over the whole
 * library can quietly repoint anchors that were right.
 */
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
      await db
        .select({
          spotifyTrackId: trackRecording.spotifyTrackId,
          recordingMbid: trackRecording.recordingMbid,
          matchedBy: trackRecording.matchedBy,
        })
        .from(trackRecording)
        .where(
          inArray(
            trackRecording.spotifyTrackId,
            rows.map((row) => row.spotifyTrackId),
          ),
        )
    ).map((row) => [row.spotifyTrackId, row]),
  );

  let written = 0;
  for (const row of rows) {
    const held = existing.get(row.spotifyTrackId);
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

/* -------------------------------------------------------------- album --- */

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
    })
    .from(spotifyAlbum)
    .where(eq(spotifyAlbum.spotifyId, albumId));
  if (!album) throw new Error(`Unknown album ${albumId}`);

  const tracks = await db
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

  // Works are read after anchoring, not with the release, so a box set we own
  // one track of costs one request rather than a hundred. Reading the tree
  // above a recording nobody in the library has is work for a library that
  // does not exist yet.
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

  await db
    .update(spotifyAlbum)
    .set({
      mbReleaseId: match.releaseMbid,
      mbCheckedAt: new Date(),
      mbReleaseCandidates: 1,
    })
    .where(eq(spotifyAlbum.spotifyId, albumId));

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

/**
 * Anchor tracks by ISRC alone, without knowing their release.
 *
 * An ISRC identifies a recording, so it does not need a release to resolve —
 * the search index answers directly. That matters because a track whose album
 * is not in MusicBrainz, or whose release we could not identify, is otherwise
 * unreachable: release-first ingest anchors nothing for 202 of our albums,
 * and 1,556 tracks that the older ISRC-only pass had resolved were left
 * behind by it.
 *
 * Batched twenty at a time, because the search takes a Lucene OR over ISRCs
 * and a long query makes the server answer 503 far more often.
 */
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
    if (!row.isrc) continue;
    byIsrc.set(row.isrc, [...(byIsrc.get(row.isrc) ?? []), row.spotifyId]);
  }

  const isrcs = [...byIsrc.keys()];
  let requests = 0;
  let anchored = 0;

  for (let i = 0; i < isrcs.length; i += 20) {
    const batch = isrcs.slice(i, i + 20);
    const found = await source.recordingsByIsrc(batch);
    requests++;

    for (const [isrc, recordingMbid] of found) {
      // Remember the mapping so a later lookup of the same ISRC is a join.
      await db.insert(mbRecordingIsrc).values({ isrc, recordingMbid }).onConflictDoNothing();

      // A stub, so the anchor points at something the cache holds. The search
      // gives an MBID and nothing else; the stub is what queues the lookup
      // that turns it into a title, works and credits.
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

/** The works reachable from the recordings this album's tracks are anchored to. */
async function worksReachedByAlbum(albumId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workMbid: mbRecordingWork.workMbid })
    .from(trackRecording)
    .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId))
    .innerJoin(mbRecordingWork, eq(mbRecordingWork.recordingMbid, trackRecording.recordingMbid))
    .where(eq(spotifyTrack.spotifyAlbumId, albumId));
  return rows.map((row) => row.workMbid);
}

/**
 * Albums whose MusicBrainz side is not yet cached.
 *
 * Two kinds, and the cheap kind comes first. An album whose release we already
 * know costs one request to cache; an album with no release yet costs a search
 * and a fetch per candidate and may still come to nothing. Draining the cheap
 * ones first means a run that is interrupted has spent its budget on the work
 * most likely to have paid off.
 *
 * Within the second kind, never-checked albums come before ones already looked
 * at, and the oldest check comes round again after that — MusicBrainz grows,
 * and an album absent last month may be there now, possibly because we added
 * it.
 */
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

/**
 * Albums whose release is cached and whose tracks can be anchored.
 *
 * `includeAnchored` re-anchors albums that already have anchors, which is what
 * a change to the matching rules needs: anchoring costs no requests, so
 * re-running it over everything is cheap and is the only way a rule change
 * reaches rows decided under the old rule.
 */
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
