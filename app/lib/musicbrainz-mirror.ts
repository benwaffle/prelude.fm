// Answers from our own `mb_*` tables when they hold the whole answer (the dump import and every
// earlier web-service read write the same shape), and asks the web service only when they don't.
// A partial answer is never served as a whole one: a release missing its URL links or with a
// recording read only as a stub goes to the web service.
//
// Answers read here are marked (`markCachedAnswer`), so the ingest path neither counts them as
// requests nor writes them back.
//
// Not for Recheck or anything else asking whether MusicBrainz changed: this answers with what we
// already hold.
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from './db';
import { jsonList } from './db/chunked';
import {
  mbArtist,
  mbRecording,
  mbRecordingIsrc,
  mbRelease,
  mbReleaseTrack,
  mbReleaseUrl,
  mbWork,
  mbWorkCatalogue,
} from './db/schema';
import { normalizeIsrc } from './isrc';
import {
  markCachedAnswer,
  type MbArtist,
  type MbCredit,
  type MbRelation,
  type MbRelease,
  type MbReleaseRecording,
  type MbWork,
  type MbWorkRef,
  type MusicBrainzSource,
} from './musicbrainz-source';

export const SPOTIFY_ALBUM_URL_PREFIX = 'https://open.spotify.com/album/';

export function spotifyAlbumUrl(spotifyAlbumId: string): string {
  return `${SPOTIFY_ALBUM_URL_PREFIX}${spotifyAlbumId}`;
}

/** The longest barcode MusicBrainz stores (GTIN-14); padding is tried up to it. */
const MAX_BARCODE_LENGTH = 14;

// UPC-12 and EAN-13 differ by a leading zero, and the index is on the stored text, so each padding
// is asked for rather than trimming the column.
function barcodeVariants(barcode: string): string[] {
  const bare = barcode.trim().replace(/^0+/, '');
  if (!bare) return [];
  const variants = [bare];
  for (let padded = `0${bare}`; padded.length <= MAX_BARCODE_LENGTH; padded = `0${padded}`) {
    variants.push(padded);
  }
  return variants;
}

type RecordingRow = { mbid: string; title: string; length: number | null };

// One read per table for a set of recordings already known to be cached in full.
async function recordingsFromCache(rows: RecordingRow[]): Promise<Map<string, MbReleaseRecording>> {
  const ids = rows.map((row) => row.mbid);
  const [isrcs, works, credits] = await Promise.all([
    db.all<{ recordingMbid: string; isrc: string }>(sql`
      select recording_mbid as recordingMbid, isrc from mb_recording_isrc
       where recording_mbid in (${jsonList(ids)}) order by isrc`),
    db.all<{ recordingMbid: string; workMbid: string; title: string | null }>(sql`
      select rw.recording_mbid as recordingMbid, rw.work_mbid as workMbid, w.title
        from mb_recording_work rw left join mb_work w on w.mbid = rw.work_mbid
       where rw.recording_mbid in (${jsonList(ids)}) order by rw.work_mbid`),
    db.all<{
      recordingMbid: string;
      artistMbid: string;
      role: string;
      instrument: string;
      name: string | null;
    }>(sql`
      select c.recording_mbid as recordingMbid, c.artist_mbid as artistMbid, c.role,
             c.instrument, a.name
        from mb_recording_credit c left join mb_artist a on a.mbid = c.artist_mbid
       where c.recording_mbid in (${jsonList(ids)})`),
  ]);

  const byId = new Map<string, MbReleaseRecording>();
  for (const row of rows) {
    byId.set(row.mbid, {
      id: row.mbid,
      title: row.title,
      length: row.length,
      isrcs: [],
      works: [],
      credits: [],
      // Not cached per recording: the printed credit only fills `mb_artist.credited_name`.
      artistCredit: [],
    });
  }
  for (const row of isrcs) byId.get(row.recordingMbid)?.isrcs.push(row.isrc);
  for (const row of works) {
    byId.get(row.recordingMbid)?.works.push({ id: row.workMbid, title: row.title ?? '' });
  }
  for (const row of credits) {
    const credit: MbCredit = {
      artistId: row.artistMbid,
      name: row.name ?? '',
      role: row.role,
      instrument: row.instrument === '' ? null : row.instrument,
    };
    byId.get(row.recordingMbid)?.credits.push(credit);
  }
  return byId;
}

async function releaseFromCache(releaseMbid: string): Promise<MbRelease | null> {
  const [release] = await db
    .select()
    .from(mbRelease)
    .where(and(eq(mbRelease.mbid, releaseMbid), isNotNull(mbRelease.urlRelationsFetchedAt)));
  if (!release) return null;

  const tracks = await db
    .select({
      medium: mbReleaseTrack.medium,
      position: mbReleaseTrack.position,
      title: mbReleaseTrack.title,
      length: mbReleaseTrack.length,
      recordingMbid: mbReleaseTrack.recordingMbid,
      recordingTitle: mbRecording.title,
      recordingLength: mbRecording.length,
      detail: mbRecording.detail,
    })
    .from(mbReleaseTrack)
    .leftJoin(mbRecording, eq(mbRecording.mbid, mbReleaseTrack.recordingMbid))
    .where(eq(mbReleaseTrack.releaseMbid, releaseMbid))
    .orderBy(asc(mbReleaseTrack.medium), asc(mbReleaseTrack.position));
  // No tracks, or a recording we hold only as a stub: the tables don't hold this release whole.
  if (tracks.length === 0 || tracks.some((track) => track.detail !== 'full')) return null;

  const urls = await db
    .select()
    .from(mbReleaseUrl)
    .where(eq(mbReleaseUrl.releaseMbid, releaseMbid));
  const recordings = await recordingsFromCache(
    [...new Map(tracks.map((track) => [track.recordingMbid, track])).values()].map((track) => ({
      mbid: track.recordingMbid,
      title: track.recordingTitle ?? '',
      length: track.recordingLength,
    })),
  );

  return {
    id: release.mbid,
    title: release.title,
    barcode: release.barcode,
    date: release.date,
    country: release.country,
    urlRelations: urls.map((url) => ({
      url: url.url,
      relationshipType: url.relationshipType,
      relationshipTypeId: url.relationshipTypeId,
      ended: url.ended,
      begin: url.begin,
      end: url.end,
      attributes: url.attributes,
    })),
    tracks: tracks.map((track) => ({
      medium: track.medium,
      position: track.position,
      title: track.title,
      length: track.length,
      recording: recordings.get(track.recordingMbid)!,
    })),
  };
}

async function workFromCache(workMbid: string): Promise<MbWork | null> {
  const [work] = await db
    .select()
    .from(mbWork)
    .where(and(eq(mbWork.mbid, workMbid), eq(mbWork.detail, 'full')));
  if (!work) return null;

  const [parent, composer, catalogues, parts] = await Promise.all([
    work.parentMbid
      ? db
          .select({ mbid: mbWork.mbid, title: mbWork.title })
          .from(mbWork)
          .where(eq(mbWork.mbid, work.parentMbid))
      : [],
    work.composerMbid
      ? db
          .select({ mbid: mbArtist.mbid, name: mbArtist.name })
          .from(mbArtist)
          .where(eq(mbArtist.mbid, work.composerMbid))
      : [],
    db.select().from(mbWorkCatalogue).where(eq(mbWorkCatalogue.workMbid, workMbid)),
    db
      .select({ mbid: mbWork.mbid, title: mbWork.title, orderingKey: mbWork.orderingKey })
      .from(mbWork)
      .where(eq(mbWork.parentMbid, workMbid)),
  ]);

  // Rebuilt as the relations the readers in `musicbrainz.ts` look for; only what we cached.
  const relations: MbRelation[] = [];
  if (work.parentMbid) {
    relations.push({
      type: 'parts',
      direction: 'backward',
      'target-type': 'work',
      ...(work.orderingKey === null ? {} : { 'ordering-key': work.orderingKey }),
      work: { id: work.parentMbid, title: parent[0]?.title ?? '' },
    });
  }
  for (const part of parts) {
    relations.push({
      type: 'parts',
      direction: 'forward',
      'target-type': 'work',
      ...(part.orderingKey === null ? {} : { 'ordering-key': part.orderingKey }),
      work: { id: part.mbid, title: part.title },
    });
  }
  if (work.composerMbid) {
    relations.push({
      type: 'composer',
      direction: 'backward',
      'target-type': 'artist',
      artist: { id: work.composerMbid, name: composer[0]?.name ?? '' },
    });
  }
  if (work.imslpUrl) {
    relations.push({
      type: 'download for free',
      direction: 'forward',
      'target-type': 'url',
      url: { resource: work.imslpUrl },
    });
  }
  for (const catalogue of catalogues) {
    relations.push({
      type: 'part of',
      direction: 'forward',
      'target-type': 'series',
      series: { id: catalogue.seriesMbid, name: catalogue.system, type: 'Catalogue' },
      'attribute-values': { number: `${catalogue.system} ${catalogue.number}` },
    });
  }
  return { id: work.mbid, title: work.title, type: work.type, relations };
}

async function artistFromCache(artistMbid: string): Promise<MbArtist | null> {
  const [artist] = await db
    .select()
    .from(mbArtist)
    .where(
      and(
        eq(mbArtist.mbid, artistMbid),
        isNotNull(mbArtist.sortName),
        isNotNull(mbArtist.linksReadAt),
      ),
    );
  if (!artist) return null;
  return {
    id: artist.mbid,
    name: artist.name,
    'sort-name': artist.sortName,
    type: artist.type,
    'life-span': {
      begin: artist.beginYear === null ? null : String(artist.beginYear),
      end: artist.endYear === null ? null : String(artist.endYear),
    },
    relations: artist.spotifyArtistId
      ? [
          {
            type: 'free streaming',
            direction: 'forward',
            'target-type': 'url',
            url: { resource: `https://open.spotify.com/artist/${artist.spotifyArtistId}` },
          },
        ]
      : [],
  };
}

export function musicBrainzMirror(fallback: MusicBrainzSource): MusicBrainzSource {
  return {
    name: `mirror+${fallback.name}`,

    async releasesByBarcode(barcode) {
      const variants = barcodeVariants(barcode);
      if (variants.length === 0) return [];
      const rows = await db
        .select({ mbid: mbRelease.mbid })
        .from(mbRelease)
        .where(inArray(mbRelease.barcode, variants))
        .orderBy(asc(mbRelease.mbid));
      // None held is not "MusicBrainz has none": the tables hold only part of MusicBrainz.
      if (rows.length === 0) return fallback.releasesByBarcode(barcode);
      return markCachedAnswer(rows.map((row) => row.mbid));
    },

    async releasesLinkedToSpotifyAlbum(spotifyAlbumId) {
      const rows = await db
        .selectDistinct({ mbid: mbReleaseUrl.releaseMbid })
        .from(mbReleaseUrl)
        .where(
          and(eq(mbReleaseUrl.url, spotifyAlbumUrl(spotifyAlbumId)), eq(mbReleaseUrl.ended, false)),
        )
        .orderBy(asc(mbReleaseUrl.releaseMbid));
      return markCachedAnswer(rows.map((row) => row.mbid));
    },

    // Fuzzy search is the web service's; the tables can't answer it.
    searchReleases: (title, trackCount) => fallback.searchReleases(title, trackCount),

    async releaseWithRecordings(releaseId) {
      const cached = await releaseFromCache(releaseId);
      return cached ? markCachedAnswer(cached) : fallback.releaseWithRecordings(releaseId);
    },

    async releaseRecordingIds(releaseId) {
      const rows = await db
        .select({ recordingMbid: mbReleaseTrack.recordingMbid })
        .from(mbReleaseTrack)
        .where(eq(mbReleaseTrack.releaseMbid, releaseId))
        .orderBy(asc(mbReleaseTrack.medium), asc(mbReleaseTrack.position));
      if (rows.length === 0) return fallback.releaseRecordingIds(releaseId);
      return markCachedAnswer(rows.map((row) => row.recordingMbid));
    },

    // Held ISRCs are answered here; only the rest are asked for. Of several recordings sharing an
    // ISRC the first is returned, as the web-service search does.
    async recordingsByIsrc(isrcs) {
      const wanted = [...new Set(isrcs.map((isrc) => normalizeIsrc(isrc)).filter(Boolean))];
      const found = new Map<string, string>();
      if (wanted.length > 0) {
        const rows = await db
          .select({ isrc: mbRecordingIsrc.isrc, recordingMbid: mbRecordingIsrc.recordingMbid })
          .from(mbRecordingIsrc)
          .where(sql`${mbRecordingIsrc.isrc} in (${jsonList(wanted)})`)
          .orderBy(asc(mbRecordingIsrc.isrc), asc(mbRecordingIsrc.recordingMbid));
        for (const row of rows) if (!found.has(row.isrc)) found.set(row.isrc, row.recordingMbid);
      }
      const missing = wanted.filter((isrc) => !found.has(isrc));
      if (missing.length === 0) return markCachedAnswer(found);
      for (const [isrc, recordingMbid] of await fallback.recordingsByIsrc(missing)) {
        if (!found.has(isrc)) found.set(isrc, recordingMbid);
      }
      return found;
    },

    async recordingWorks(recordingId) {
      const [recording] = await db
        .select({ mbid: mbRecording.mbid })
        .from(mbRecording)
        .where(and(eq(mbRecording.mbid, recordingId), eq(mbRecording.detail, 'full')));
      if (!recording) return fallback.recordingWorks(recordingId);
      const works = await db.all<MbWorkRef>(sql`
        select rw.work_mbid as id, coalesce(w.title, '') as title
          from mb_recording_work rw left join mb_work w on w.mbid = rw.work_mbid
         where rw.recording_mbid = ${recordingId} order by rw.work_mbid`);
      return markCachedAnswer(works);
    },

    async recordingDetail(recordingId) {
      const [recording] = await db
        .select({ mbid: mbRecording.mbid, title: mbRecording.title, length: mbRecording.length })
        .from(mbRecording)
        .where(and(eq(mbRecording.mbid, recordingId), eq(mbRecording.detail, 'full')));
      if (!recording) return fallback.recordingDetail(recordingId);
      const detail = (await recordingsFromCache([recording])).get(recordingId)!;
      return markCachedAnswer(detail);
    },

    async work(workId) {
      const cached = await workFromCache(workId);
      return cached ? markCachedAnswer(cached) : fallback.work(workId);
    },

    async artist(artistId) {
      const cached = await artistFromCache(artistId);
      return cached ? markCachedAnswer(cached) : fallback.artist(artistId);
    },
  };
}
