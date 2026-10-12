/** Submits nothing. */
import { eq } from 'drizzle-orm';
import { db } from './db';
import { spotifyAlbum } from './db/schema';
import { ingestAlbum } from './musicbrainz-ingest';
import { ingestRelease, releaseIsCached } from './musicbrainz-cache';
import type { PickedReleaseAttachOutcome, PickedReleaseAttachRequest } from './musicbrainz-pick';
import type { MusicBrainzSource } from './musicbrainz-source';

// Does not ingest, write the ledger, or invent cache rows for releases seen only on a live lookup.
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

/** Lookup-by-MBID does not wait for the barcode search index. */
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
