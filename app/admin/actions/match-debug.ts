'use server';

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jsonList } from '@/lib/db/chunked';
import { heldWorkLinks } from '@/lib/db/held-work-links';
import { subtreeOf } from '@/lib/db/work-tree-sql';
import { BUCKETS, placeTrack, readinessTracksFrom } from '@/lib/catalogue-readiness';
import { GAP_REASONS } from '@/lib/gap-reasons';
import {
  projectMusicBrainzLibrary,
  type MusicBrainzGapCode,
  type ProjectedRecordingWork,
} from '@/lib/musicbrainz-library';
import { loadMusicBrainzLibraryFacts } from '@/lib/musicbrainz-library-read';
import type { TrackClassification } from '@/lib/musicbrainz-library-facts';
import { loadReadinessSubmissions } from '../lib/catalogue-readiness-load';
import { parseMatchDebugQuery, type MatchDebugQuery } from '../lib/match-debug-query';
import { checkAuth } from './auth';

const TRACK_LIMIT = 400;

export type MatchDebugWork = {
  linkedBy: 'musicbrainz' | 'prelude';
  confidence: 'high' | 'medium' | 'low' | null;
  /** Root first; `filed` marks the level the player files the track under. */
  chain: { mbid: string; title: string | null; type: string | null; filed: boolean }[];
  /** Set when the chain is empty because the work was never read. */
  relatedWorkMbid: string;
  catalogues: string[];
  composer: { mbid: string; name: string | null } | null;
};

export type MatchDebugTrack = {
  spotifyTrackId: string;
  title: string;
  disc: number;
  number: number;
  durationMs: number;
  isrc: string | null;
  recording:
    | {
        state: 'linked';
        mbid: string;
        title: string | null;
        lengthMs: number | null;
        matchedBy: string;
        read: boolean;
      }
    | { state: 'contested'; reason: string; candidates: string[] }
    | { state: 'none' };
  works: MatchDebugWork[];
  classification: TrackClassification | null;
  /** MusicBrainz's evidence alone would call it classical. */
  musicBrainzSaysClassical: boolean;
  verdict:
    | { state: 'ready'; viaOwnLink: boolean }
    | { state: 'not_classical' }
    | { state: 'held'; label: string; detail: string; waiting: boolean };
  gaps: { code: MusicBrainzGapCode; reason: string }[];
  queue: {
    status: string;
    attempts: number;
    outcome: string | null;
    reason: string | null;
    error: string | null;
    processedAt: number | null;
  } | null;
};

export type MatchDebugAlbum = {
  spotifyAlbumId: string;
  title: string;
  year: number | null;
  upc: string | null;
  spotifyTrackTotal: number | null;
  release: {
    state: 'not_checked' | 'missing' | 'ambiguous' | 'matched' | 'misaligned';
    mbid: string | null;
    title: string | null;
    barcode: string | null;
    candidates: number | null;
    checkedAt: number | null;
    tracklist: 'aligned' | 'misaligned' | 'not_read' | null;
  };
  tracks: MatchDebugTrack[];
};

export type MatchDebugResult = {
  query: MatchDebugQuery['kind'];
  albums: MatchDebugAlbum[];
  tracks: number;
  /** More tracks matched than are shown. */
  truncated: boolean;
};

type SearchRow = { spotifyTrackId: string; isrc: string | null };

function heldTracksUnder(works: SQL): SQL {
  return sql`t.spotify_id in (select spotify_track_id from (${heldWorkLinks({ works })}))`;
}

function whereFor(query: MatchDebugQuery): SQL {
  switch (query.kind) {
    case 'spotify':
      return sql`(t.spotify_id = ${query.id} or a.spotify_id = ${query.id})`;
    case 'isrc':
      return sql`t.isrc = ${query.isrc}`;
    case 'barcode':
      return sql`ltrim(a.upc, '0') = ltrim(${query.digits}, '0')`;
    case 'mbid':
      return sql`(a.mb_release_id = ${query.mbid}
        or t.spotify_id in (select spotify_track_id from track_recording where recording_mbid = ${query.mbid})
        or ${heldTracksUnder(subtreeOf(jsonList([query.mbid])))})`;
    case 'text': {
      const matches = (column: SQL) => sql`instr(lower(${column}), lower(${query.text})) > 0`;
      return sql`(${matches(sql`t.title`)} or ${matches(sql`a.title`)}
        or ${heldTracksUnder(subtreeOf(sql`select mbid from mb_work where ${matches(sql`title`)}`))})`;
    }
  }
}

// One query finds the tracks; the rest is the facts loader and projection the player and the
// readiness funnel use, so this page cannot disagree with either.
export async function getMatchDebug(input: string): Promise<MatchDebugResult | null> {
  await checkAuth();
  const query = parseMatchDebugQuery(input);
  if (!query) return null;

  const found = await db.all<SearchRow>(sql`
    select t.spotify_id as spotifyTrackId, t.isrc
      from spotify_track t join spotify_album a on a.spotify_id = t.spotify_album_id
     where ${whereFor(query)}
     order by a.title, a.spotify_id, t.disc_number, t.track_number
     limit ${TRACK_LIMIT + 1}`);
  const shown = found.slice(0, TRACK_LIMIT);
  const trackIds = shown.map((row) => row.spotifyTrackId);
  if (trackIds.length === 0) return { query: query.kind, albums: [], tracks: 0, truncated: false };

  const ids = jsonList(trackIds);
  const [facts, submissions, queueRows, albumRows] = await Promise.all([
    loadMusicBrainzLibraryFacts(trackIds),
    loadReadinessSubmissions(db),
    db.all<{
      spotifyTrackId: string;
      status: string;
      attempts: number;
      outcome: string | null;
      reason: string | null;
      error: string | null;
      processedAt: number | null;
    }>(sql`
      select spotify_id as spotifyTrackId, status, attempts, pipeline_outcome as outcome,
             pipeline_reason as reason, error_message as error,
             coalesce(pipeline_completed_at, processed_at) as processedAt
        from match_queue where spotify_id in (${ids})`),
    db.all<{
      spotifyAlbumId: string;
      title: string;
      year: number | null;
      upc: string | null;
      spotifyTrackTotal: number | null;
      candidates: number | null;
      checkedAt: number | null;
      releaseMbid: string | null;
      releaseTitle: string | null;
      releaseBarcode: string | null;
    }>(sql`
      select a.spotify_id as spotifyAlbumId, a.title, a.year, a.upc,
             a.spotify_track_total as spotifyTrackTotal, a.mb_release_candidates as candidates,
             a.mb_checked_at as checkedAt, a.mb_release_id as releaseMbid,
             r.title as releaseTitle, r.barcode as releaseBarcode
        from spotify_album a left join mb_release r on r.mbid = a.mb_release_id
       where a.spotify_id in (select spotify_album_id from spotify_track where spotify_id in (${ids}))`),
  ]);

  const projection = projectMusicBrainzLibrary(facts);
  const readiness = readinessTracksFrom(
    facts,
    projection,
    new Map(shown.map((row) => [row.spotifyTrackId, row.isrc])),
  );
  const readinessByTrack = new Map(readiness.map((track) => [track.spotifyTrackId, track]));
  const providerTrackById = new Map(
    facts.providerTracks.map((track) => [track.spotifyTrackId, track]),
  );
  const anchorByTrack = new Map(facts.anchors.map((anchor) => [anchor.spotifyTrackId, anchor]));
  const recordingById = new Map(facts.mbRecordings.map((recording) => [recording.mbid, recording]));
  const classificationByTrack = new Map(
    facts.classifications.map((classification) => [classification.spotifyTrackId, classification]),
  );
  const gapsByTrack = new Map(projection.accounting.map((track) => [track.spotifyTrackId, track]));
  const queueByTrack = new Map(queueRows.map((row) => [row.spotifyTrackId, row]));

  // Same lookup `readinessTracksFrom` makes: held recordings first, then what a held-back track has.
  const worksByTrack = new Map<string, ProjectedRecordingWork[]>();
  for (const recording of projection.recordings) {
    for (const trackId of recording.heldTrackIds) worksByTrack.set(trackId, recording.works);
  }
  for (const unresolved of projection.unresolvedTracks) {
    const works = unresolved.musicBrainz?.works ?? unresolved.ownWorks;
    if (works) worksByTrack.set(unresolved.spotifyTrackId, works);
  }

  const albums = new Map<string, MatchDebugAlbum>();
  for (const row of albumRows) {
    const firstTrack = readiness.find((track) => track.spotifyAlbumId === row.spotifyAlbumId);
    const resolution = facts.providerAlbums.find(
      (album) => album.spotifyAlbumId === row.spotifyAlbumId,
    )?.releaseResolution;
    albums.set(row.spotifyAlbumId, {
      spotifyAlbumId: row.spotifyAlbumId,
      title: row.title,
      year: row.year,
      upc: row.upc,
      spotifyTrackTotal: row.spotifyTrackTotal,
      release: {
        state: resolution?.state ?? 'not_checked',
        mbid: row.releaseMbid,
        title: row.releaseTitle,
        barcode: row.releaseBarcode,
        candidates: row.candidates,
        checkedAt: row.checkedAt,
        tracklist: firstTrack?.tracklist ?? null,
      },
      tracks: [],
    });
  }

  for (const spotifyTrackId of trackIds) {
    const provider = providerTrackById.get(spotifyTrackId);
    const ready = readinessByTrack.get(spotifyTrackId);
    const album = provider && albums.get(provider.spotifyAlbumId);
    if (!provider || !ready || !album) continue;
    const anchor = anchorByTrack.get(spotifyTrackId);
    const recording =
      anchor?.state === 'accepted' ? recordingById.get(anchor.recordingMbid) : undefined;
    const placement =
      ready.classification === 'not_classical' ? null : placeTrack(ready, submissions);
    const queue = queueByTrack.get(spotifyTrackId);
    album.tracks.push({
      spotifyTrackId,
      title: provider.title,
      disc: provider.discNumber,
      number: provider.trackNumber,
      durationMs: provider.durationMs,
      isrc: ready.isrc,
      recording:
        anchor?.state === 'accepted'
          ? {
              state: 'linked',
              mbid: anchor.recordingMbid,
              title: recording?.title ?? null,
              lengthMs: recording?.lengthMs ?? null,
              matchedBy: anchor.matchedBy,
              read: recording?.detail === 'full',
            }
          : anchor?.state === 'conflicting'
            ? {
                state: 'contested',
                reason: anchor.reason,
                candidates: anchor.candidateRecordingMbids,
              }
            : { state: 'none' },
      works: (ready.link.state === 'contested' ? [] : (worksByTrack.get(spotifyTrackId) ?? [])).map(
        debugWork,
      ),
      classification: classificationByTrack.get(spotifyTrackId) ?? null,
      musicBrainzSaysClassical: ready.musicBrainzSaysClassical,
      verdict:
        ready.classification === 'not_classical'
          ? { state: 'not_classical' }
          : placement
            ? {
                state: 'held',
                label: BUCKETS[placement.bucket].label,
                detail: BUCKETS[placement.bucket].detail,
                waiting: placement.waiting,
              }
            : {
                state: 'ready',
                viaOwnLink: ready.works.some((work) => work.linkedBy === 'prelude'),
              },
      gaps: [...new Set(gapsByTrack.get(spotifyTrackId)?.gapCodes ?? [])].map((code) => ({
        code,
        reason: GAP_REASONS[code],
      })),
      queue: queue
        ? {
            status: queue.status,
            attempts: queue.attempts,
            outcome: queue.outcome,
            reason: queue.reason,
            error: queue.error,
            processedAt: queue.processedAt,
          }
        : null,
    });
  }

  return {
    query: query.kind,
    albums: [...albums.values()]
      .filter((album) => album.tracks.length > 0)
      .sort(
        (left, right) =>
          trackIds.indexOf(left.tracks[0].spotifyTrackId) -
          trackIds.indexOf(right.tracks[0].spotifyTrackId),
      ),
    tracks: trackIds.length,
    truncated: found.length > TRACK_LIMIT,
  };
}

function debugWork(work: ProjectedRecordingWork): MatchDebugWork {
  return {
    linkedBy: work.linkedBy,
    confidence: work.linkConfidence,
    relatedWorkMbid: work.relatedWorkMbid,
    chain: work.hierarchy.map((node) => ({
      mbid: node.mbid,
      title: node.title,
      type: node.type,
      filed: node.mbid === work.displayWorkMbid,
    })),
    catalogues: [...new Set(work.catalogues.map((ref) => `${ref.system} ${ref.number}`))],
    composer: work.composer ? { mbid: work.composer.mbid, name: work.composer.name } : null,
  };
}
