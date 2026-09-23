/**
 * Pull MusicBrainz facts the person already submitted into the cache.
 *
 * Confirm writes the ledger and does not talk to MusicBrainz. Recheck used to
 * observe only the cache, so a landed edit stayed invisible until a later
 * ingest — which the worker skips once tracks are already anchored. Recheck
 * now fetches, then observes. It still submits nothing.
 */

import { ingestAlbum } from './musicbrainz-ingest';
import { ingestRecording, ingestRelease, ingestWorkTree } from './musicbrainz-cache';
import { attachPickedRelease } from './musicbrainz-contributions';
import type { PickedReleaseAttachOutcome } from './musicbrainz-pick';
import type { MusicBrainzSource } from './musicbrainz-source';

export type PendingLedgerPull = {
  kind: string;
  targetMbid: string | null;
  subject: string;
  value: string | null;
  evidence: Record<string, unknown> | null;
};

function asMbid(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function evidenceMbid(evidence: Record<string, unknown> | null, key: string): string | null {
  return asMbid(evidence?.[key]);
}

function evidenceMbids(evidence: Record<string, unknown> | null, key: string): string[] {
  const value = evidence?.[key];
  if (!Array.isArray(value)) return [];
  return value.map(asMbid).filter((mbid): mbid is string => mbid !== null);
}

/**
 * Fetch a chosen release by MBID, attach it to the Spotify album, then run
 * the album ingest so tracks anchor and works are read.
 *
 * Lookup-by-MBID does not wait for the barcode search index.
 */
export async function adoptReleaseForAlbum(
  source: MusicBrainzSource,
  albumId: string,
  releaseMbid: string,
): Promise<PickedReleaseAttachOutcome> {
  const attached = await attachPickedRelease({ albumId, releaseMbid });
  if (attached.attached) {
    await ingestAlbum(source, albumId, { fetchWorks: true });
    return attached;
  }
  if (attached.reason !== 'release_not_in_cache') return attached;

  const ingested = await ingestRelease(source, releaseMbid, { fetchWorks: false });
  if (!ingested.found) return { attached: false, reason: 'release_not_found' };

  const after = await attachPickedRelease({ albumId, releaseMbid });
  if (!after.attached) return after;
  await ingestAlbum(source, albumId, { fetchWorks: true });
  return after;
}

/**
 * Refresh the album's MusicBrainz release into the cache.
 *
 * A known MBID (from the ledger or a pick) is fetched directly. Otherwise the
 * usual barcode/title match runs against live MusicBrainz.
 */
export async function pullAlbumFromMusicBrainz(
  source: MusicBrainzSource,
  albumId: string,
  knownReleaseMbid?: string | null,
): Promise<{ requests: number; releaseMbid: string | null }> {
  if (knownReleaseMbid) {
    const adopted = await adoptReleaseForAlbum(source, albumId, knownReleaseMbid);
    if (adopted.attached) {
      return { requests: 0, releaseMbid: adopted.releaseMbid };
    }
    if (adopted.reason === 'album_already_matched') {
      const report = await ingestAlbum(source, albumId, { fetchWorks: true });
      return { requests: report.requests, releaseMbid: report.releaseMbid };
    }
  }

  const report = await ingestAlbum(source, albumId, { fetchWorks: true });
  return { requests: report.requests, releaseMbid: report.releaseMbid };
}

/**
 * Re-read every pending ledger target from MusicBrainz. Does not mark applied.
 */
export async function pullPendingSubmissionsFromMusicBrainz(
  source: MusicBrainzSource,
  rows: PendingLedgerPull[],
): Promise<{ requests: number }> {
  let requests = 0;
  const releases = new Set<string>();
  const recordings = new Set<string>();
  const works = new Set<string>();
  const albums = new Map<string, string | null>();

  for (const row of rows) {
    if (row.kind === 'release') {
      albums.set(row.subject, evidenceMbid(row.evidence, 'releaseMbid'));
      continue;
    }
    if (row.kind === 'barcode' || row.kind === 'streaming_url') {
      if (row.targetMbid) releases.add(row.targetMbid);
      continue;
    }
    if (row.kind === 'isrc') {
      const fromEvidence = evidenceMbid(row.evidence, 'releaseMbid');
      if (fromEvidence) releases.add(fromEvidence);
      continue;
    }
    if (row.kind === 'work_relationship' && row.targetMbid) recordings.add(row.targetMbid);
    if (row.kind === 'work' && row.targetMbid) works.add(row.targetMbid);
    if (row.kind === 'error') {
      const problem = row.evidence?.problem;
      if (problem === 'contested_isrc') {
        for (const mbid of evidenceMbids(row.evidence, 'recordingMbids')) recordings.add(mbid);
      }
      if (problem === 'misaligned_tracklist') {
        const releaseMbid = evidenceMbid(row.evidence, 'releaseMbid') ?? asMbid(row.targetMbid);
        if (releaseMbid) releases.add(releaseMbid);
      }
    }
  }

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

  return { requests };
}
