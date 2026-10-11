/**
 * Pull a Spotify album's MusicBrainz release into the cache and attach it.
 *
 * Serves a person picking a release in the Inbox, a release they confirm
 * with its new MBID, and a Recheck of a release submission
 * (`submission-kinds`). Submits nothing.
 */
import { eq } from 'drizzle-orm';
import { db } from './db';
import { spotifyAlbum } from './db/schema';
import { ingestAlbum } from './musicbrainz-ingest';
import { ingestRelease, releaseIsCached } from './musicbrainz-cache';
import type { PickedReleaseAttachOutcome, PickedReleaseAttachRequest } from './musicbrainz-pick';
import type { MusicBrainzSource } from './musicbrainz-source';

/**
 * Attach a picked release to its Spotify album when the release is already
 * cached. Does not ingest, does not write the ledger, and does not invent
 * cache rows for releases MusicBrainz returned only on a live lookup.
 */
export async function attachPickedRelease(
  request: PickedReleaseAttachRequest,
): Promise<PickedReleaseAttachOutcome> {
  const [album] = await db
    .select({
      spotifyId: spotifyAlbum.spotifyId,
      mbReleaseId: spotifyAlbum.mbReleaseId,
    })
    .from(spotifyAlbum)
    .where(eq(spotifyAlbum.spotifyId, request.albumId));
  if (!album) return { attached: false, reason: 'album_not_found' };
  if (album.mbReleaseId) return { attached: false, reason: 'album_already_matched' };
  if (!(await releaseIsCached(request.releaseMbid))) {
    return { attached: false, reason: 'release_not_in_cache' };
  }

  await db
    .update(spotifyAlbum)
    .set({
      mbReleaseId: request.releaseMbid,
      mbCheckedAt: new Date(),
      mbReleaseCandidates: 1,
    })
    .where(eq(spotifyAlbum.spotifyId, request.albumId));

  return { attached: true, releaseMbid: request.releaseMbid };
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
