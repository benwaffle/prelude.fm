/**
 * What we know that MusicBrainz does not.
 *
 * Every gap here is a contribution waiting to be made. The cache makes them
 * ordinary queries rather than searches: once an album's release is cached
 * and its tracks are anchored, "this recording has no ISRC and we hold one"
 * is a join.
 *
 * The standard for submitting is deliberately stricter than the standard for
 * anchoring, and the difference is the whole point of this file. Anchoring is
 * a belief about our own library, and being wrong costs us a mismatched
 * track. Submitting is a claim on a database other people rely on, and being
 * wrong costs *them* — a bad ISRC is how Haydn's Symphony 87 lost its link.
 * So a track can be confidently anchored and still not be evidence enough to
 * submit.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import {
  diagnoseTracklist,
  POSITION_TOLERANCE_MS,
  type TracklistDiagnosis,
} from './musicbrainz-matching';
import type { IsrcGap } from './musicbrainz-edit-links';
import {
  ISRC_SUBMISSION_TOLERANCE_MS,
  releaseMediumKey,
  verifyBarcodeRelease,
  verifiedIsrcReleaseMedia,
  type MusicBrainzBarcodeEvidence,
  type MusicBrainzReleaseEvidence,
  type SpotifyBarcodeEvidence,
  type SpotifyReleaseEvidence,
} from './musicbrainz-contribution-safety';
import {
  mbRecording,
  mbRecordingIsrc,
  mbArtist,
  mbRelease,
  mbReleaseTrack,
  mbWork,
  mbWorkCatalogue,
  mbSubmission,
  composer,
  spotifyAlbum,
  spotifyTrack,
  trackWorkPartV2,
  trackRecording,
  work,
  workCatalogV2,
  workPartV2,
} from './db/schema';

/**
 * How closely a duration must agree before we will tell MusicBrainz an ISRC
 * belongs to a recording.
 *
 * Three seconds — the standard already used for ISRC submissions here, and
 * tighter than the fifteen that anchoring allows on an aligned tracklist. A
 * track can be confidently ours and still not be proof enough for somebody
 * else's database.
 */
export type { IsrcGap } from './musicbrainz-edit-links';
export {
  harmonyImportLink,
  magicIsrcLink,
  recordingEditLink,
  releaseEditLink,
  workCreateLink,
} from './musicbrainz-edit-links';

/**
 * Recordings we can name an ISRC for that MusicBrainz does not have one for.
 *
 * The conditions are the evidence, stated as a query:
 *
 * - the album's barcode is exactly the release's, so this really is the
 *   record the label pressed;
 * - the complete Spotify album and MusicBrainz release have identical track
 *   counts (or every repeated hybrid layer does), and every track maps
 *   one-to-one by anchored recording with its duration agreeing within three
 *   seconds;
 * - MusicBrainz holds no ISRC for that recording yet; and
 * - we have not already submitted this one, whoever submitted it.
 *
 * Tracks anchored *by* ISRC are absent by construction: if the ISRC resolved
 * the recording, MusicBrainz already had it.
 */
export async function isrcGaps(limit = 200): Promise<IsrcGap[]> {
  const candidates = await isrcGapRows();
  if (candidates.length === 0) return [];

  const albumIds = [...new Set(candidates.map((row) => row.albumId))];
  const releaseMbids = [...new Set(candidates.map((row) => row.releaseMbid))];
  const [spotifyEvidence, musicbrainzEvidence] = await Promise.all([
    spotifyReleaseEvidence(albumIds),
    musicbrainzReleaseEvidence(releaseMbids),
  ]);
  const verified = verifiedIsrcReleaseMedia(spotifyEvidence, musicbrainzEvidence);

  return dedupeByRecording(
    candidates.filter((gap) =>
      verified.has(releaseMediumKey(gap.albumId, gap.releaseMbid, gap.medium)),
    ),
  ).slice(0, limit);
}

/**
 * One row per recording, not per position it occupies.
 *
 * A hybrid SACD is three mediums in MusicBrainz — a CD layer and two SACD
 * layers — listing the same recordings on each, so a join through the
 * tracklist returns every ISRC three times. Left alone that inflates the
 * count on the button, and spends the bot's per-album allowance on the same
 * edit repeatedly.
 *
 * The earliest position wins, which for a hybrid disc is the CD layer.
 */
function dedupeByRecording(rows: IsrcGap[]): IsrcGap[] {
  const byPair = new Map<string, IsrcGap>();
  for (const row of rows) {
    const key = `${row.recordingMbid}:${row.isrc}`;
    const seen = byPair.get(key);
    if (
      !seen ||
      row.medium < seen.medium ||
      (row.medium === seen.medium && row.position < seen.position)
    ) {
      byPair.set(key, row);
    }
  }
  return [...byPair.values()];
}

async function isrcGapRows(): Promise<IsrcGap[]> {
  const delta = sql<number>`abs(coalesce(${mbReleaseTrack.length}, ${mbRecording.length}) - ${spotifyTrack.durationMs})`;

  return db
    .select({
      spotifyTrackId: spotifyTrack.spotifyId,
      trackTitle: spotifyTrack.title,
      albumId: spotifyAlbum.spotifyId,
      albumTitle: spotifyAlbum.title,
      isrc: sql<string>`${spotifyTrack.isrc}`,
      recordingMbid: trackRecording.recordingMbid,
      recordingTitle: mbRecording.title,
      releaseMbid: mbRelease.mbid,
      barcode: mbRelease.barcode,
      upc: sql<string | null>`${spotifyAlbum.upc}`,
      medium: mbReleaseTrack.medium,
      position: mbReleaseTrack.position,
      durationDeltaMs: delta,
      matchedBy: trackRecording.matchedBy,
    })
    .from(trackRecording)
    .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId))
    .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
    .innerJoin(mbRelease, eq(mbRelease.mbid, spotifyAlbum.mbReleaseId))
    .innerJoin(mbRecording, eq(mbRecording.mbid, trackRecording.recordingMbid))
    .innerJoin(
      mbReleaseTrack,
      and(
        eq(mbReleaseTrack.releaseMbid, mbRelease.mbid),
        eq(mbReleaseTrack.recordingMbid, trackRecording.recordingMbid),
      ),
    )
    .where(
      and(
        sql`${spotifyTrack.isrc} is not null`,
        // The barcode must be the release's own, ignoring the zero padding
        // that distinguishes a UPC-12 from the same EAN-13.
        sql`ltrim(coalesce(${spotifyAlbum.upc}, ''), '0') = ltrim(coalesce(${mbRelease.barcode}, ''), '0')`,
        sql`ltrim(coalesce(${spotifyAlbum.upc}, ''), '0') <> ''`,
        sql`coalesce(${mbReleaseTrack.length}, ${mbRecording.length}) is not null`,
        sql`${delta} <= ${ISRC_SUBMISSION_TOLERANCE_MS}`,
        sql`not exists (
          select 1 from ${mbRecordingIsrc}
          where ${mbRecordingIsrc.recordingMbid} = ${trackRecording.recordingMbid}
            and ${mbRecordingIsrc.isrc} = ${spotifyTrack.isrc}
        )`,
        sql`not exists (
          select 1 from ${mbSubmission}
          where ${mbSubmission.kind} = 'isrc'
            and ${mbSubmission.targetMbid} = ${trackRecording.recordingMbid}
            and ${mbSubmission.value} = ${spotifyTrack.isrc}
        )`,
      ),
    );
}

async function spotifyReleaseEvidence(albumIds: string[]): Promise<SpotifyReleaseEvidence[]> {
  const rows = await db
    .select({
      albumId: spotifyAlbum.spotifyId,
      releaseMbid: spotifyAlbum.mbReleaseId,
      upc: spotifyAlbum.upc,
      spotifyTrackId: spotifyTrack.spotifyId,
      recordingMbid: trackRecording.recordingMbid,
      durationMs: spotifyTrack.durationMs,
    })
    .from(spotifyTrack)
    .innerJoin(spotifyAlbum, eq(spotifyAlbum.spotifyId, spotifyTrack.spotifyAlbumId))
    .leftJoin(trackRecording, eq(trackRecording.spotifyTrackId, spotifyTrack.spotifyId))
    .where(inArray(spotifyAlbum.spotifyId, albumIds));

  return rows.flatMap((row) =>
    row.releaseMbid === null ? [] : [{ ...row, releaseMbid: row.releaseMbid }],
  );
}

async function musicbrainzReleaseEvidence(
  releaseMbids: string[],
): Promise<MusicBrainzReleaseEvidence[]> {
  return db
    .select({
      releaseMbid: mbReleaseTrack.releaseMbid,
      barcode: mbRelease.barcode,
      medium: mbReleaseTrack.medium,
      position: mbReleaseTrack.position,
      recordingMbid: mbReleaseTrack.recordingMbid,
      durationMs: sql<number | null>`coalesce(${mbReleaseTrack.length}, ${mbRecording.length})`,
    })
    .from(mbReleaseTrack)
    .innerJoin(mbRelease, eq(mbRelease.mbid, mbReleaseTrack.releaseMbid))
    .innerJoin(mbRecording, eq(mbRecording.mbid, mbReleaseTrack.recordingMbid))
    .where(inArray(mbReleaseTrack.releaseMbid, releaseMbids));
}

/**
 * Releases MusicBrainz holds that carry no ISRC at all, with how many we
 * could supply.
 *
 * Grouped by release because that is how the submission is made: MagicISRC
 * takes a release and a set of positions, so one visit contributes every ISRC
 * an album is missing rather than one.
 */
export type IsrcGapRelease = {
  releaseMbid: string;
  albumId: string;
  albumTitle: string;
  missing: number;
  gaps: IsrcGap[];
};

export async function isrcGapsByRelease(limit = 100): Promise<IsrcGapRelease[]> {
  const gaps = await isrcGaps(2_000);
  const byRelease = new Map<string, IsrcGapRelease>();
  for (const gap of gaps) {
    const existing = byRelease.get(gap.releaseMbid);
    if (existing) {
      existing.missing++;
      existing.gaps.push(gap);
    } else {
      byRelease.set(gap.releaseMbid, {
        releaseMbid: gap.releaseMbid,
        albumId: gap.albumId,
        albumTitle: gap.albumTitle,
        missing: 1,
        gaps: [gap],
      });
    }
  }
  return [...byRelease.values()].sort((a, b) => b.missing - a.missing).slice(0, limit);
}

/**
 * Recordings MusicBrainz holds but has never linked to a work.
 *
 * The highest-value human class: we can find the recording and we can often
 * propose the work, because a sibling recording on the same release already
 * points at one. The human step is a confirmation rather than a search.
 */
export type WorkRelationshipGap = {
  recordingMbid: string;
  recordingTitle: string;
  albumId: string;
  /** Null when the album's release is not cached; the recording is still actionable. */
  releaseMbid: string | null;
  albumTitle: string;
  tracks: number;
  candidates: WorkCandidate[];
  proposals: WorkCreationProposal[];
};

export type WorkCandidate = {
  workMbid: string;
  title: string;
  type: string | null;
  composerMbid: string | null;
  composerName: string | null;
  catalogues: { system: string; number: string }[];
  evidence: ('existing_mb_part_link' | 'existing_mb_work_link' | 'catalogue_match')[];
};

export type WorkCreationProposal = {
  localWorkId: number;
  title: string;
  type: string | null;
  composerName: string;
  composerMbid: string | null;
  catalogues: { system: string; number: string }[];
  /** Always proposal: these fields came from the legacy parser/manual model. */
  provenance: 'legacy_proposal';
};

export async function workRelationshipGaps(limit = 100): Promise<WorkRelationshipGap[]> {
  const gaps = await db
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
      sql`not exists (
        select 1 from mb_recording_work
        where mb_recording_work.recording_mbid = ${trackRecording.recordingMbid}
      )`,
    )
    .groupBy(trackRecording.recordingMbid)
    .limit(limit);
  if (gaps.length === 0) return [];

  const recordingMbids = gaps.map((gap) => gap.recordingMbid);
  const localRows = await db
    .select({
      recordingMbid: trackRecording.recordingMbid,
      localWorkId: work.id,
      workTitle: work.title,
      parserType: work.parserForm,
      workMbid: work.musicbrainzId,
      partMbid: workPartV2.musicbrainzId,
      composerName: composer.name,
      composerMbid: composer.musicbrainzId,
    })
    .from(trackRecording)
    .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId))
    .innerJoin(trackWorkPartV2, eq(trackWorkPartV2.spotifyTrackId, spotifyTrack.spotifyId))
    .innerJoin(workPartV2, eq(workPartV2.id, trackWorkPartV2.workPartId))
    .innerJoin(work, eq(work.id, workPartV2.workId))
    .innerJoin(composer, eq(composer.id, work.composerId))
    .where(inArray(trackRecording.recordingMbid, recordingMbids));

  const localWorkIds = [...new Set(localRows.map((row) => row.localWorkId))];
  const localCatalogues =
    localWorkIds.length === 0
      ? []
      : await db
          .select({
            localWorkId: workCatalogV2.workId,
            system: workCatalogV2.system,
            number: workCatalogV2.number,
            normalizedSystem: workCatalogV2.normalizedSystem,
            normalizedNumber: workCatalogV2.normalizedNumber,
            source: workCatalogV2.source,
          })
          .from(workCatalogV2)
          .where(inArray(workCatalogV2.workId, localWorkIds));

  const cataloguesByLocalWork = new Map<
    number,
    {
      system: string;
      number: string;
      normalizedSystem: string;
      normalizedNumber: string;
      source: 'parser' | 'musicbrainz';
    }[]
  >();
  for (const catalogue of localCatalogues) {
    const rows = cataloguesByLocalWork.get(catalogue.localWorkId) ?? [];
    rows.push(catalogue);
    cataloguesByLocalWork.set(catalogue.localWorkId, rows);
  }

  const allMbCatalogues = await db.select().from(mbWorkCatalogue);
  const mbidsByCatalogue = new Map<string, string[]>();
  for (const catalogue of allMbCatalogues) {
    const key = `${catalogue.normalizedSystem}\u0000${catalogue.normalizedNumber}`;
    const mbids = mbidsByCatalogue.get(key) ?? [];
    mbids.push(catalogue.workMbid);
    mbidsByCatalogue.set(key, mbids);
  }

  const candidateEvidence = new Map<string, Map<string, Set<WorkCandidate['evidence'][number]>>>();
  const addCandidate = (
    recordingMbid: string,
    workMbid: string | null,
    source: WorkCandidate['evidence'][number],
  ) => {
    if (!workMbid) return;
    const byWork = candidateEvidence.get(recordingMbid) ?? new Map();
    const sources = byWork.get(workMbid) ?? new Set();
    sources.add(source);
    byWork.set(workMbid, sources);
    candidateEvidence.set(recordingMbid, byWork);
  };

  for (const row of localRows) {
    addCandidate(row.recordingMbid, row.partMbid, 'existing_mb_part_link');
    addCandidate(row.recordingMbid, row.workMbid, 'existing_mb_work_link');
    for (const catalogue of cataloguesByLocalWork.get(row.localWorkId) ?? []) {
      const key = `${catalogue.normalizedSystem}\u0000${catalogue.normalizedNumber}`;
      for (const workMbid of mbidsByCatalogue.get(key) ?? []) {
        addCandidate(row.recordingMbid, workMbid, 'catalogue_match');
      }
    }
  }

  const candidateMbids = [
    ...new Set([...candidateEvidence.values()].flatMap((byWork) => [...byWork.keys()])),
  ];
  const [candidateRows, candidateCatalogues] = await Promise.all([
    candidateMbids.length === 0
      ? []
      : db
          .select({
            workMbid: mbWork.mbid,
            title: mbWork.title,
            type: mbWork.type,
            composerMbid: mbWork.composerMbid,
            composerName: mbArtist.name,
          })
          .from(mbWork)
          .leftJoin(mbArtist, eq(mbArtist.mbid, mbWork.composerMbid))
          .where(inArray(mbWork.mbid, candidateMbids)),
    candidateMbids.length === 0
      ? []
      : db
          .select({
            workMbid: mbWorkCatalogue.workMbid,
            system: mbWorkCatalogue.system,
            number: mbWorkCatalogue.number,
          })
          .from(mbWorkCatalogue)
          .where(inArray(mbWorkCatalogue.workMbid, candidateMbids)),
  ]);
  const candidateByMbid = new Map(candidateRows.map((row) => [row.workMbid, row]));
  const candidateCataloguesByMbid = new Map<string, { system: string; number: string }[]>();
  for (const catalogue of candidateCatalogues) {
    const rows = candidateCataloguesByMbid.get(catalogue.workMbid) ?? [];
    rows.push({ system: catalogue.system, number: catalogue.number });
    candidateCataloguesByMbid.set(catalogue.workMbid, rows);
  }

  return gaps.map((gap) => {
    const proposals = new Map<number, WorkCreationProposal>();
    for (const row of localRows.filter(
      (candidate) => candidate.recordingMbid === gap.recordingMbid,
    )) {
      proposals.set(row.localWorkId, {
        localWorkId: row.localWorkId,
        title: row.workTitle,
        type: row.parserType,
        composerName: row.composerName,
        composerMbid: row.composerMbid,
        catalogues: (cataloguesByLocalWork.get(row.localWorkId) ?? [])
          .filter((catalogue) => catalogue.source === 'parser')
          .map((catalogue) => ({
            system: catalogue.system,
            number: catalogue.number,
          })),
        provenance: 'legacy_proposal',
      });
    }

    const candidates: WorkCandidate[] = [];
    for (const [workMbid, evidence] of candidateEvidence.get(gap.recordingMbid) ?? []) {
      const row = candidateByMbid.get(workMbid);
      if (!row) continue;
      candidates.push({
        ...row,
        catalogues: candidateCataloguesByMbid.get(workMbid) ?? [],
        evidence: [...evidence],
      });
    }
    candidates.sort((a, b) => {
      const rank = (candidate: WorkCandidate) =>
        candidate.evidence.includes('existing_mb_part_link')
          ? 0
          : candidate.evidence.includes('existing_mb_work_link')
            ? 1
            : 2;
      return rank(a) - rank(b) || a.title.localeCompare(b.title);
    });

    return { ...gap, candidates, proposals: [...proposals.values()] };
  });
}

/**
 * ISRCs MusicBrainz maps to more than one recording.
 *
 * Not our gap but an upstream error, and one that costs us real links: a
 * label attached Sony's ISRC for Haydn's Symphony 87 to a recording of
 * Symphony 82, and our matcher could only refuse to choose. We find these, so
 * we can report them.
 */
export type ContestedIsrc = {
  isrc: string;
  recordings: number;
  titles: string;
};

export async function contestedIsrcs(limit = 100): Promise<ContestedIsrc[]> {
  return db
    .select({
      isrc: mbRecordingIsrc.isrc,
      recordings: sql<number>`count(*)`,
      titles: sql<string>`group_concat(${mbRecording.title}, ' / ')`,
    })
    .from(mbRecordingIsrc)
    .innerJoin(mbRecording, eq(mbRecording.mbid, mbRecordingIsrc.recordingMbid))
    .groupBy(mbRecordingIsrc.isrc)
    .having(sql`count(*) > 1`)
    .limit(limit);
}

/**
 * Albums MusicBrainz does not hold as a release.
 *
 * The largest remaining gap by a distance, and the one class that stays
 * human permanently: a duplicate release is expensive for other people to
 * merge away, and that cost is not ours to impose. Harmony seeds the form
 * from the Spotify album, so the human step is checking rather than typing.
 *
 * Ordered by how much of the library each would unlock, because adding a
 * thirty-track box set is worth more than adding a single.
 */
export type MissingRelease = {
  albumId: string;
  albumTitle: string;
  year: number | null;
  upc: string | null;
  tracks: number;
  /** Tracks still reaching no MusicBrainz recording at all. */
  unanchored: number;
  /** Why the lookup failed, as far as we know. */
  reason: string;
};

export async function missingReleases(limit = 60): Promise<MissingRelease[]> {
  return db
    .select({
      albumId: spotifyAlbum.spotifyId,
      albumTitle: spotifyAlbum.title,
      year: spotifyAlbum.year,
      upc: sql<string | null>`${spotifyAlbum.upc}`,
      tracks: sql<number>`count(distinct ${spotifyTrack.spotifyId})`,
      unanchored: sql<number>`count(distinct case when not exists (
        select 1 from ${trackRecording} tr where tr.spotify_track_id = ${spotifyTrack.spotifyId}
      ) then ${spotifyTrack.spotifyId} end)`,
      reason: sql<string>`case
        when ${spotifyAlbum.upc} is null or ${spotifyAlbum.upc} = '' then 'Spotify gives no barcode'
        when coalesce(${spotifyAlbum.mbReleaseCandidates}, 0) > 1 then 'several releases share the barcode'
        else 'no release carries this barcode'
      end`,
    })
    .from(spotifyAlbum)
    .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyAlbumId, spotifyAlbum.spotifyId))
    .where(sql`${spotifyAlbum.mbReleaseId} is null`)
    .groupBy(spotifyAlbum.spotifyId)
    .orderBy(sql`count(distinct ${spotifyTrack.spotifyId}) desc`)
    .limit(limit);
}

/**
 * Releases MusicBrainz holds without a barcode, where Spotify gives us one.
 *
 * Small, because a release is usually found *by* its barcode in the first
 * place — these are the ones matched on title and duration instead.
 */
export type BarcodeGap = {
  releaseMbid: string;
  releaseTitle: string;
  albumId: string;
  barcode: string;
  trackCount: number;
  maxDurationDeltaMs: number;
};

export async function barcodeGaps(limit = 50): Promise<BarcodeGap[]> {
  const candidates = await db
    .select({
      releaseMbid: mbRelease.mbid,
      releaseTitle: mbRelease.title,
      albumId: spotifyAlbum.spotifyId,
      barcode: sql<string>`${spotifyAlbum.upc}`,
    })
    .from(spotifyAlbum)
    .innerJoin(mbRelease, eq(mbRelease.mbid, spotifyAlbum.mbReleaseId))
    .where(
      and(
        sql`${mbRelease.barcode} is null or ${mbRelease.barcode} = ''`,
        sql`${spotifyAlbum.upc} is not null and ${spotifyAlbum.upc} <> ''`,
        sql`not exists (
          select 1 from ${mbSubmission}
          where ${mbSubmission.kind} = 'barcode'
            and ${mbSubmission.targetMbid} = ${mbRelease.mbid}
        )`,
      ),
    );
  if (candidates.length === 0) return [];

  const albumIds = [...new Set(candidates.map((candidate) => candidate.albumId))];
  const releaseMbids = [...new Set(candidates.map((candidate) => candidate.releaseMbid))];
  const [spotifyRows, musicbrainzRows] = await Promise.all([
    db
      .select({
        albumId: spotifyAlbum.spotifyId,
        albumTitle: spotifyAlbum.title,
        discNumber: spotifyTrack.discNumber,
        trackNumber: spotifyTrack.trackNumber,
        durationMs: spotifyTrack.durationMs,
      })
      .from(spotifyAlbum)
      .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyAlbumId, spotifyAlbum.spotifyId))
      .where(inArray(spotifyAlbum.spotifyId, albumIds)),
    db
      .select({
        releaseMbid: mbRelease.mbid,
        releaseTitle: mbRelease.title,
        medium: mbReleaseTrack.medium,
        position: mbReleaseTrack.position,
        durationMs: sql<number | null>`coalesce(${mbReleaseTrack.length}, ${mbRecording.length})`,
      })
      .from(mbRelease)
      .innerJoin(mbReleaseTrack, eq(mbReleaseTrack.releaseMbid, mbRelease.mbid))
      .innerJoin(mbRecording, eq(mbRecording.mbid, mbReleaseTrack.recordingMbid))
      .where(inArray(mbRelease.mbid, releaseMbids)),
  ]);

  const spotifyByAlbum = new Map<string, SpotifyBarcodeEvidence[]>();
  for (const row of spotifyRows) {
    const rows = spotifyByAlbum.get(row.albumId) ?? [];
    rows.push(row);
    spotifyByAlbum.set(row.albumId, rows);
  }
  const musicbrainzByRelease = new Map<string, MusicBrainzBarcodeEvidence[]>();
  for (const row of musicbrainzRows) {
    const rows = musicbrainzByRelease.get(row.releaseMbid) ?? [];
    rows.push(row);
    musicbrainzByRelease.set(row.releaseMbid, rows);
  }

  return candidates
    .flatMap((candidate) => {
      const verification = verifyBarcodeRelease(
        spotifyByAlbum.get(candidate.albumId) ?? [],
        musicbrainzByRelease.get(candidate.releaseMbid) ?? [],
      );
      return verification ? [{ ...candidate, ...verification }] : [];
    })
    .slice(0, limit);
}

/**
 * Albums whose tracklist does not line up with the release we matched.
 *
 * Anchoring refuses these, which is right, but refusing silently makes them
 * look like albums MusicBrainz simply has nothing for. They are the
 * opposite: MusicBrainz has the release and one of the two tracklists is
 * wrong. A reordered one is an error somebody can fix — and it is not
 * always MusicBrainz's, which is why this reports rather than submits.
 */
export type MisalignedAlbum = {
  albumId: string;
  albumTitle: string;
  releaseMbid: string;
  diagnosis: TracklistDiagnosis;
  /**
   * Only the positions that disagree.
   *
   * An album can line up for twenty tracks and part company on the
   * twenty-first; showing the first few rows would show the agreement and
   * hide the problem.
   */
  mismatches: {
    position: number;
    ourTitle: string | null;
    ourMs: number | null;
    theirTitle: string | null;
    theirMs: number | null;
  }[];
  ourCount: number;
  theirCount: number;
  /** Tracks anchored anyway, by ISRC, which needs no tracklist at all. */
  anchoredByIsrc: number;
};

export async function misalignedAlbums(limit = 40): Promise<MisalignedAlbum[]> {
  const albums = await db
    .select({
      albumId: spotifyAlbum.spotifyId,
      albumTitle: spotifyAlbum.title,
      releaseMbid: sql<string>`${spotifyAlbum.mbReleaseId}`,
    })
    .from(spotifyAlbum)
    .where(
      and(
        sql`${spotifyAlbum.mbReleaseId} is not null`,
        sql`exists (select 1 from ${mbReleaseTrack} where ${mbReleaseTrack.releaseMbid} = ${spotifyAlbum.mbReleaseId})`,
      ),
    );

  const out: MisalignedAlbum[] = [];
  for (const album of albums) {
    const ours = await db
      .select({
        medium: spotifyTrack.discNumber,
        position: spotifyTrack.trackNumber,
        title: spotifyTrack.title,
        durationMs: spotifyTrack.durationMs,
      })
      .from(spotifyTrack)
      .where(eq(spotifyTrack.spotifyAlbumId, album.albumId))
      .orderBy(spotifyTrack.discNumber, spotifyTrack.trackNumber);

    const theirs = await db
      .select({
        medium: mbReleaseTrack.medium,
        position: mbReleaseTrack.position,
        title: mbReleaseTrack.title,
        length: mbReleaseTrack.length,
      })
      .from(mbReleaseTrack)
      .where(eq(mbReleaseTrack.releaseMbid, album.releaseMbid))
      .orderBy(mbReleaseTrack.medium, mbReleaseTrack.position);

    const diagnosis = diagnoseTracklist(
      ours.map((t) => ({
        discNumber: t.medium,
        trackNumber: t.position,
        durationMs: t.durationMs,
      })),
      theirs.map((t) => ({ medium: t.medium, position: t.position, length: t.length })),
    );
    if (diagnosis.kind === 'aligned') continue;

    const [anchored] = await db
      .select({ n: sql<number>`count(*)` })
      .from(trackRecording)
      .innerJoin(spotifyTrack, eq(spotifyTrack.spotifyId, trackRecording.spotifyTrackId))
      .where(
        and(eq(spotifyTrack.spotifyAlbumId, album.albumId), eq(trackRecording.matchedBy, 'isrc')),
      );

    const mismatches: MisalignedAlbum['mismatches'] = [];
    for (let i = 0; i < Math.max(ours.length, theirs.length); i++) {
      const ourTrack = ours[i];
      const theirTrack = theirs[i];
      const agree =
        ourTrack &&
        theirTrack &&
        theirTrack.length != null &&
        Math.abs(theirTrack.length - ourTrack.durationMs) <= POSITION_TOLERANCE_MS;
      if (agree) continue;
      mismatches.push({
        position: i + 1,
        ourTitle: ourTrack?.title ?? null,
        ourMs: ourTrack?.durationMs ?? null,
        theirTitle: theirTrack?.title ?? null,
        theirMs: theirTrack?.length ?? null,
      });
      if (mismatches.length >= 8) break;
    }

    out.push({
      ...album,
      diagnosis,
      mismatches,
      ourCount: ours.length,
      theirCount: theirs.length,
      anchoredByIsrc: anchored?.n ?? 0,
    });
    if (out.length >= limit) break;
  }

  // Reordered first: it is the one that is plainly somebody's error.
  const rank = (a: MisalignedAlbum) => (a.diagnosis.kind === 'reordered' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** How much of each kind of contribution is waiting. */
export async function contributionCounts() {
  const [isrc, works, contested, missing, barcodes, misaligned, submitted] = await Promise.all([
    isrcGaps(5_000).then((rows) => rows.length),
    workRelationshipGaps(5_000).then((rows) => rows.length),
    contestedIsrcs(5_000).then((rows) => rows.length),
    missingReleases(5_000).then((rows) => rows.length),
    barcodeGaps(5_000).then((rows) => rows.length),
    misalignedAlbums(5_000).then((rows) => rows.length),
    db
      .select({ outcome: mbSubmission.outcome, n: sql<number>`count(*)` })
      .from(mbSubmission)
      .groupBy(mbSubmission.outcome),
  ]);
  return {
    isrc,
    workRelationships: works,
    contestedIsrcs: contested,
    missingReleases: missing,
    barcodes,
    misaligned,
    submissions: Object.fromEntries(submitted.map((row) => [row.outcome, row.n])),
  };
}
