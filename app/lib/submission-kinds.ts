/**
 * Has a submission landed? One answer per kind of edit.
 *
 * Every kind says two things: what to re-read from MusicBrainz before
 * deciding (`pull`), and which of its rows the cache then shows (`landed`).
 * `pullAndApply` serves both a single row's Recheck and Recheck all from
 * these, so the rule for "landed" exists once per kind rather than once per
 * button.
 *
 * Confirm writes the ledger and does not talk to MusicBrainz. Recheck fetches,
 * then observes, because the worker skips ingesting tracks already anchored.
 * It never submits anything, and a missing edit ID stays missing.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from './db';
import { forChunks } from './db/chunked';
import { mbSubmission } from './db/schema';
import { contestedIsrcs } from './gaps/contested';
import { misalignedAlbums } from './gaps/misaligned';
import { streamingUrlStates } from './gaps/streaming-urls';
import { ingestRecording, ingestRelease, ingestWorkTree } from './musicbrainz-cache';
import type { MusicBrainzSource } from './musicbrainz-source';
import { pullAlbumFromMusicBrainz } from './musicbrainz-submission-pull';
import type { SubmissionEvidence, SubmissionKind } from './submission-evidence';
import type { LedgerRow } from './submission-ledger';

/** A ledger row of one kind, with that kind's evidence. */
type RowOf<K extends SubmissionKind> = LedgerRow & {
  kind: K;
  evidence: Extract<SubmissionEvidence, { kind: K }>;
};

/** What MusicBrainz must be re-read for. Shared targets are fetched once. */
type PullTargets = {
  releases?: (string | null)[];
  recordings?: (string | null)[];
  works?: (string | null)[];
  /** A Spotify album to match again, with the release MBID the person named, if any. */
  album?: { albumId: string; releaseMbid: string | null };
};

type KindSpec<K extends SubmissionKind> = {
  pull: (row: RowOf<K>) => PullTargets;
  /** The ids, among `rows`, of the edits the cache now holds. */
  landed: (rows: RowOf<K>[]) => Promise<number[]>;
};

/** Rows whose `exists` check against the cache holds. */
function landedWhere(exists: SQL) {
  return async (rows: LedgerRow[]) => {
    const landed = await forChunks(
      rows.map((row) => row.id),
      (ids) =>
        db
          .select({ id: mbSubmission.id })
          .from(mbSubmission)
          .where(and(inArray(mbSubmission.id, ids), exists)),
    );
    return landed.map((row) => row.id);
  };
}

const KINDS: { [K in SubmissionKind]: KindSpec<K> } = {
  isrc: {
    pull: (row) => ({ releases: [row.evidence.releaseMbid] }),
    landed: landedWhere(sql`exists (
      select 1 from mb_recording_isrc
      where mb_recording_isrc.recording_mbid = ${mbSubmission.targetMbid}
        and mb_recording_isrc.isrc = ${mbSubmission.value}
    )`),
  },
  barcode: {
    pull: (row) => ({ releases: [row.targetMbid] }),
    // Whitespace is no barcode.
    landed: landedWhere(sql`exists (
      select 1 from mb_release
      where mb_release.mbid = ${mbSubmission.targetMbid}
        and trim(mb_release.barcode) <> ''
    )`),
  },
  work_relationship: {
    pull: (row) => ({ recordings: [row.targetMbid] }),
    landed: landedWhere(sql`exists (
      select 1 from mb_recording_work
      where mb_recording_work.recording_mbid = ${mbSubmission.targetMbid}
        and mb_recording_work.work_mbid = ${mbSubmission.value}
    )`),
  },
  work: {
    pull: (row) => ({ works: [row.targetMbid] }),
    // Only a full fetch is MusicBrainz showing the work; a stub is still a hole.
    landed: landedWhere(sql`exists (
      select 1 from mb_work
      where mb_work.mbid = ${mbSubmission.targetMbid}
        and mb_work.detail = 'full'
    )`),
  },
  release: {
    pull: (row) => ({ album: { albumId: row.subject, releaseMbid: row.evidence.releaseMbid } }),
    landed: landedWhere(sql`exists (
      select 1 from spotify_album
      where spotify_album.spotify_id = ${mbSubmission.subject}
        and spotify_album.mb_release_id is not null
    )`),
  },
  streaming_url: {
    pull: (row) => ({ releases: [row.targetMbid] }),
    // Present in the cache, not merely submitted: unfetched relations stay pending.
    landed: async (rows) => {
      const states = await streamingUrlStates(
        rows.flatMap((row) => (row.targetMbid ? [row.targetMbid] : [])),
      );
      return rows
        .filter((row) => row.targetMbid && states.get(row.targetMbid) === 'present')
        .map((row) => row.id);
    },
  },
  error: {
    pull: (row) => {
      const evidence = row.evidence;
      if (evidence.problem === 'contested_isrc') return { recordings: evidence.recordingMbids };
      if (evidence.problem === 'misaligned_tracklist') {
        return { releases: [evidence.releaseMbid ?? row.targetMbid] };
      }
      return {};
    },
    // A report lands when the cache no longer shows the contradiction.
    landed: async (rows) => {
      const contested = rows.filter((row) => row.evidence.problem === 'contested_isrc');
      const misaligned = rows.filter((row) => row.evidence.problem === 'misaligned_tracklist');
      const isrcs = contested.flatMap((row) => (row.value ? [row.value] : []));
      const albumIds = misaligned.map((row) => row.subject);
      const [stillContested, stillMisaligned] = await Promise.all([
        isrcs.length === 0 ? [] : contestedIsrcs({ isrcs }),
        albumIds.length === 0 ? [] : misalignedAlbums({ albumIds }),
      ]);
      const contestedNow = new Set(stillContested.map((row) => row.isrc));
      const misalignedNow = new Set(stillMisaligned.map((album) => album.albumId));
      return [
        ...contested.filter((row) => row.value && !contestedNow.has(row.value)),
        ...misaligned.filter((row) => !misalignedNow.has(row.subject)),
      ].map((row) => row.id);
    },
  },
};

const SUBMISSION_KINDS = mbSubmission.kind.enumValues;

function rowsOf<K extends SubmissionKind>(rows: readonly LedgerRow[], kind: K): RowOf<K>[] {
  return rows.filter((row): row is RowOf<K> => row.kind === kind && row.evidence.kind === kind);
}

function pullTargetsOf<K extends SubmissionKind>(rows: readonly LedgerRow[], kind: K) {
  return rowsOf(rows, kind).map((row) => KINDS[kind].pull(row));
}

async function landedOf<K extends SubmissionKind>(
  rows: readonly LedgerRow[],
  kind: K,
): Promise<number[]> {
  const own = rowsOf(rows, kind);
  return own.length === 0 ? [] : KINDS[kind].landed(own);
}

/** Re-read every target behind `rows` from MusicBrainz, each once. Marks nothing. */
async function pull(
  source: MusicBrainzSource,
  rows: readonly LedgerRow[],
): Promise<{ requests: number; targets: number }> {
  const targets = SUBMISSION_KINDS.flatMap((kind) => pullTargetsOf(rows, kind));
  const unique = (list: (string | null)[]) =>
    new Set(list.filter((mbid): mbid is string => typeof mbid === 'string' && mbid.length > 0));
  const releases = unique(targets.flatMap((target) => target.releases ?? []));
  const recordings = unique(targets.flatMap((target) => target.recordings ?? []));
  const works = unique(targets.flatMap((target) => target.works ?? []));
  // The latest row for an album names the release to fetch.
  const albums = new Map(
    targets.flatMap((target) =>
      target.album ? [[target.album.albumId, target.album.releaseMbid] as const] : [],
    ),
  );

  // One at a time: every fetch spends the shared MusicBrainz allowance.
  let requests = 0;
  for (const releaseMbid of releases) {
    requests += (await ingestRelease(source, releaseMbid, { fetchWorks: false })).requests;
  }
  for (const recordingMbid of recordings) {
    requests += (await ingestRecording(source, recordingMbid)).requests;
  }
  for (const workMbid of works) {
    requests += (await ingestWorkTree(source, workMbid)).requests;
  }
  for (const [albumId, knownReleaseMbid] of albums) {
    requests += (await pullAlbumFromMusicBrainz(source, albumId, knownReleaseMbid)).requests;
  }
  return { requests, targets: releases.size + recordings.size + works.size + albums.size };
}

export type PullAndApplyResult = {
  requests: number;
  targets: number;
  /** Rows the cache now shows, whatever their outcome was. */
  landed: Set<number>;
  /** Pending rows this marked applied. */
  applied: number;
};

/**
 * Re-read what `rows` submitted, then mark applied every pending one the
 * cache now holds. Rows of any outcome may be passed (to re-read them);
 * only pending ones change.
 */
export async function pullAndApply(
  source: MusicBrainzSource,
  rows: readonly LedgerRow[],
): Promise<PullAndApplyResult> {
  const { requests, targets } = await pull(source, rows);
  const landed = (await Promise.all(SUBMISSION_KINDS.map((kind) => landedOf(rows, kind)))).flat();
  const applied = await forChunks(landed, (ids) =>
    db
      .update(mbSubmission)
      .set({ outcome: 'applied', outcomeAt: new Date() })
      .where(and(inArray(mbSubmission.id, ids), eq(mbSubmission.outcome, 'pending')))
      .returning({ id: mbSubmission.id }),
  );
  return { requests, targets, landed: new Set(landed), applied: applied.length };
}
