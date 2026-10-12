import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { forChunks } from '../db/chunked';
import { mbRelease, mbReleaseUrl, spotifyAlbum } from '../db/schema';
import { filmScoreExclusions } from '../film-score-exclusions';
import {
  isStreamingUrlContributionGap,
  spotifyFreeStreamingUrlState,
  type ReleaseUrlRelation,
  type SpotifyFreeStreamingUrlState,
} from '../musicbrainz-manual-submissions';
import { within, without } from './scope';

// Unfetched stays unknown: an empty `mb_release_url` result is not evidence MusicBrainz has no
// External Links.
export type StreamingUrlGap = {
  releaseMbid: string;
  releaseTitle: string;
  albumId: string;
  albumTitle: string;
};

async function relationsByRelease(
  releaseMbids: string[],
): Promise<Map<string, ReleaseUrlRelation[]>> {
  const relations = await forChunks(releaseMbids, (chunk) =>
    db
      .select({
        releaseMbid: mbReleaseUrl.releaseMbid,
        url: mbReleaseUrl.url,
        relationshipTypeId: mbReleaseUrl.relationshipTypeId,
        ended: mbReleaseUrl.ended,
      })
      .from(mbReleaseUrl)
      .where(inArray(mbReleaseUrl.releaseMbid, chunk)),
  );
  const byRelease = new Map<string, ReleaseUrlRelation[]>();
  for (const relation of relations) {
    const list = byRelease.get(relation.releaseMbid) ?? [];
    list.push(relation);
    byRelease.set(relation.releaseMbid, list);
  }
  return byRelease;
}

export async function streamingUrlStates(
  releaseMbids: readonly string[],
): Promise<Map<string, SpotifyFreeStreamingUrlState>> {
  const unique = [...new Set(releaseMbids)];
  if (unique.length === 0) return new Map();
  const [releases, relations] = await Promise.all([
    forChunks(unique, (chunk) =>
      db
        .select({
          mbid: mbRelease.mbid,
          urlRelationsFetchedAt: mbRelease.urlRelationsFetchedAt,
        })
        .from(mbRelease)
        .where(inArray(mbRelease.mbid, chunk)),
    ),
    relationsByRelease(unique),
  ]);
  const fetchedAt = new Map(releases.map((row) => [row.mbid, row.urlRelationsFetchedAt]));
  return new Map(
    unique.map((mbid) => [
      mbid,
      spotifyFreeStreamingUrlState({
        urlRelationsFetchedAt: fetchedAt.get(mbid) ?? null,
        relations: relations.get(mbid) ?? [],
      }),
    ]),
  );
}

export async function streamingUrlGaps(
  scope: { releaseMbids?: readonly string[] } = {},
): Promise<StreamingUrlGap[]> {
  const film = await filmScoreExclusions();
  const candidates = await db
    .select({
      releaseMbid: mbRelease.mbid,
      releaseTitle: mbRelease.title,
      albumId: spotifyAlbum.spotifyId,
      albumTitle: spotifyAlbum.title,
      urlRelationsFetchedAt: mbRelease.urlRelationsFetchedAt,
    })
    .from(spotifyAlbum)
    .innerJoin(mbRelease, eq(mbRelease.mbid, spotifyAlbum.mbReleaseId))
    .where(
      and(
        within(mbRelease.mbid, scope.releaseMbids),
        isNotNull(mbRelease.urlRelationsFetchedAt),
        without(spotifyAlbum.spotifyId, film.albumIds),
      ),
    );
  if (candidates.length === 0) return [];

  const relations = await relationsByRelease([
    ...new Set(candidates.map((candidate) => candidate.releaseMbid)),
  ]);

  return candidates
    .filter((candidate) =>
      isStreamingUrlContributionGap(
        spotifyFreeStreamingUrlState({
          urlRelationsFetchedAt: candidate.urlRelationsFetchedAt,
          relations: relations.get(candidate.releaseMbid) ?? [],
        }),
      ),
    )
    .map(({ releaseMbid, releaseTitle, albumId, albumTitle }) => ({
      releaseMbid,
      releaseTitle,
      albumId,
      albumTitle,
    }))
    .sort(
      (a, b) =>
        a.releaseTitle.localeCompare(b.releaseTitle) || a.releaseMbid.localeCompare(b.releaseMbid),
    );
}
