// All requests go through `musicbrainz-gateway.ts`, which owns MusicBrainz's one-request-per-second
// budget.
import {
  MusicBrainzBudgetError,
  scheduleMusicBrainzRequest,
  type MusicBrainzChannel,
} from './musicbrainz-gateway';
import { normalizeIsrc } from './isrc';
import type {
  MbArtist,
  MbCredit,
  MbRelation,
  MbRelease,
  MbReleaseRecording,
  MbReleaseTrack,
  MbReleaseUrlRelation,
  MbRecordingSearchHit,
  MbWork,
  MbWorkRef,
  MusicBrainzSource,
} from './musicbrainz-source';

export type {
  MbArtist,
  MbCredit,
  MbRelation,
  MbRelease,
  MbReleaseRecording,
  MbReleaseTrack,
  MbReleaseUrlRelation,
  MbRecordingSearchHit,
  MbWork,
  MbWorkRef,
  MusicBrainzSource,
} from './musicbrainz-source';
export { MusicBrainzBudgetError };

const BASE = 'https://musicbrainz.org/ws/2';
const MAX_ATTEMPTS = 6;

const contact = process.env.MUSICBRAINZ_CONTACT ?? 'https://prelude.fm';
const userAgent = `PreludeFM/0.1 ( ${contact} )`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `backfill` is the lowest-priority read channel, so an unlabelled call waits rather than jumping a
// queue.
const DEFAULT_CHANNEL: MusicBrainzChannel = 'backfill';

export class MusicBrainzError extends Error {}

export type OnMbAttempt = () => void;

// Null for 404. MusicBrainz often answers 503 "busy" under load, so it is retried with backoff;
// each retry goes through the gateway and counts against the day's budget.
export async function mbGet<T>(
  path: string,
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<T | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await scheduleMusicBrainzRequest(channel, () =>
      fetch(`${BASE}${path}`, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } }),
    );
    onAttempt?.();

    if (response.status === 404) return null;

    if (response.ok) {
      const body = (await response.json()) as T & { error?: string };
      // A 200 carrying an `error` key is the busy response in disguise.
      if (body && typeof body === 'object' && 'error' in body && body.error) {
        if (attempt === MAX_ATTEMPTS - 1) throw new MusicBrainzError(String(body.error));
        await sleep(1_500 * 2 ** attempt);
        continue;
      }
      return body;
    }

    if (response.status === 503 || response.status >= 500) {
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new MusicBrainzError(`${response.status} after ${MAX_ATTEMPTS} attempts for ${path}`);
      }
      await sleep(1_500 * 2 ** attempt);
      continue;
    }

    throw new MusicBrainzError(`${response.status} for ${path}`);
  }
  throw new MusicBrainzError(`retries exhausted for ${path}`);
}

/** Quotes and backslashes are the only characters that end or escape a phrase. */
export function luceneQuote(value: string): string | null {
  const cleaned = value.replace(/["\\]/g, ' ').trim();
  return cleaned ? `"${cleaned}"` : null;
}

export type MbIsrcHit = { isrc: string; recording: MbRecordingSearchHit };

// One Lucene OR search instead of a request per ISRC. Only ISRCs we asked for are returned; an ISRC
// on several recordings is a hit for each.
export async function searchRecordingsByIsrcs(
  isrcs: string[],
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<MbIsrcHit[]> {
  if (isrcs.length === 0) return [];
  const wanted = new Set(isrcs.map((isrc) => normalizeIsrc(isrc)));
  const query = isrcs.map((isrc) => `isrc:${isrc}`).join(' OR ');
  const result = await mbGet<{ recordings?: MbRecordingSearchHit[] }>(
    `/recording?query=${encodeURIComponent(query)}&fmt=json&limit=100`,
    channel,
    onAttempt,
  );
  return (result?.recordings ?? []).flatMap((recording) =>
    (recording.isrcs ?? []).flatMap((reported) => {
      const isrc = normalizeIsrc(reported);
      return wanted.has(isrc) ? [{ isrc, recording }] : [];
    }),
  );
}

export async function findRecordingsByIsrcs(
  isrcs: string[],
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const { isrc, recording } of await searchRecordingsByIsrcs(isrcs, channel, onAttempt)) {
    if (!found.has(isrc)) found.set(isrc, recording.id);
  }
  return found;
}

// The search is fuzzy, so non-exact barcodes are dropped. Leading zeros are ignored (UPC-12 vs
// EAN-13).
export async function findReleasesByBarcode(
  barcode: string,
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<string[]> {
  const normalise = (value: string | null | undefined) => (value ?? '').trim().replace(/^0+/, '');
  const wanted = normalise(barcode);
  if (!wanted) return [];

  const result = await mbGet<{ releases?: { id: string; barcode?: string | null }[] }>(
    `/release?query=barcode:${encodeURIComponent(wanted)}&fmt=json&limit=25`,
    channel,
    onAttempt,
  );
  return (result?.releases ?? [])
    .filter((release) => normalise(release.barcode) === wanted)
    .map((release) => release.id);
}

// For releases MusicBrainz holds without a barcode. Fuzzy, so the caller confirms durations before
// believing it.
export async function searchReleasesByTitle(
  title: string,
  trackCount: number,
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<string[]> {
  const quoted = luceneQuote(title);
  if (!quoted) return [];
  const query = `release:${quoted} AND tracks:${trackCount}`;
  const result = await mbGet<{ releases?: { id: string; score?: number }[] }>(
    `/release?query=${encodeURIComponent(query)}&fmt=json&limit=10`,
    channel,
    onAttempt,
  );
  return (result?.releases ?? []).map((release) => release.id);
}

// A record issued in two territories is two releases with one set of recordings, so for ISRCs the
// barcode isn't really ambiguous.
export async function getReleaseRecordingIds(
  releaseId: string,
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<string[]> {
  const release = await mbGet<{
    media?: { tracks?: { recording?: { id: string } }[] }[];
  }>(`/release/${releaseId}?inc=recordings&fmt=json`, channel, onAttempt);
  const ids: string[] = [];
  for (const medium of release?.media ?? []) {
    for (const track of medium.tracks ?? []) {
      if (track.recording?.id) ids.push(track.recording.id);
    }
  }
  return ids;
}

export async function getRecordingWorks(
  recordingId: string,
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<MbWorkRef[]> {
  const recording = await mbGet<{ relations?: MbRelation[] }>(
    `/recording/${recordingId}?inc=work-rels&fmt=json`,
    channel,
    onAttempt,
  );
  const works: MbWorkRef[] = [];
  for (const relation of recording?.relations ?? []) {
    if (relation.type === 'performance' && relation.work) works.push(relation.work);
  }
  return works;
}

export async function getWork(
  workId: string,
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<MbWork | null> {
  return mbGet<MbWork>(
    `/work/${workId}?inc=work-rels+artist-rels+series-rels&fmt=json`,
    channel,
    onAttempt,
  );
}

export async function getArtist(
  artistId: string,
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<MbArtist | null> {
  return mbGet<MbArtist>(`/artist/${artistId}?inc=url-rels&fmt=json`, channel, onAttempt);
}

// One request for the whole release instead of one per recording; this shape is what makes the rate
// limit workable.
const RELEASE_INC =
  'recordings+recording-level-rels+work-rels+artist-rels+artist-credits+isrcs+url-rels+release-groups';

export type MbArtistCreditJson = { name?: string; artist?: { id: string; name: string } }[];

export function artistCreditOf(
  credit: MbArtistCreditJson | undefined,
): { artistId: string; name: string }[] {
  return (credit ?? []).flatMap((part) =>
    part.artist ? [{ artistId: part.artist.id, name: part.name || part.artist.name }] : [],
  );
}

type RawRecording = {
  id: string;
  title?: string;
  length?: number | null;
  isrcs?: string[];
  relations?: MbRelation[];
  'artist-credit'?: MbArtistCreditJson;
};

type RawRelease = {
  id: string;
  title?: string;
  barcode?: string | null;
  date?: string | null;
  country?: string | null;
  relations?: MbRelation[];
  'artist-credit'?: MbArtistCreditJson;
  'release-group'?: { id: string; title: string };
  media?: {
    position?: number;
    tracks?: {
      position?: number;
      number?: string;
      title?: string;
      length?: number | null;
      'artist-credit'?: MbArtistCreditJson;
      recording?: RawRecording;
    }[];
  }[];
};

function releaseUrlRelations(relations: MbRelation[] | undefined): MbReleaseUrlRelation[] {
  return (relations ?? []).flatMap((relation) =>
    relation['target-type'] === 'url' && relation.url?.resource && relation['type-id']
      ? [
          {
            url: relation.url.resource,
            relationshipType: relation.type,
            relationshipTypeId: relation['type-id'],
            ended: relation.ended ?? false,
            begin: relation.begin ?? null,
            end: relation.end ?? null,
            attributes: relation.attributes ?? [],
          },
        ]
      : [],
  );
}

// The attribute is only an instrument for relationship types that use it that way: `engineer` also
// carries attributes (`assistant`).
function creditsFromRelations(relations: MbRelation[] | undefined): MbCredit[] {
  const credits: MbCredit[] = [];
  for (const relation of relations ?? []) {
    if (!relation.artist) continue;
    const carriesInstrument = relation.type === 'instrument' || relation.type === 'vocal';
    credits.push({
      artistId: relation.artist.id,
      name: relation.artist.name,
      role: relation.type,
      instrument: carriesInstrument ? (relation.attributes?.[0] ?? null) : null,
    });
  }
  return credits;
}

function recordingOf(raw: RawRecording): MbReleaseRecording {
  return {
    id: raw.id,
    title: raw.title ?? '',
    length: raw.length ?? null,
    isrcs: raw.isrcs ?? [],
    works: (raw.relations ?? [])
      .filter((relation) => relation.type === 'performance' && relation.work)
      .map((relation) => relation.work as MbWorkRef),
    credits: creditsFromRelations(raw.relations),
    artistCredit: artistCreditOf(raw['artist-credit']),
  };
}

export type MbReleaseDetail = Omit<MbRelease, 'tracks'> & {
  artistCredit: { artistId: string; name: string }[];
  releaseGroup: { id: string; title: string } | null;
  media: number;
  tracks: (MbReleaseTrack & { artistCredit: { artistId: string; name: string }[] })[];
};

export async function getReleaseWithRecordings(
  releaseId: string,
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<MbReleaseDetail | null> {
  const raw = await mbGet<RawRelease>(
    `/release/${releaseId}?inc=${RELEASE_INC}&fmt=json`,
    channel,
    onAttempt,
  );
  if (!raw) return null;

  const tracks = (raw.media ?? []).flatMap((medium, mediumIndex) =>
    (medium.tracks ?? []).flatMap((track, trackIndex) => {
      const recording = track.recording;
      if (!recording) return [];
      return [
        {
          medium: medium.position ?? mediumIndex + 1,
          position: track.position ?? trackIndex + 1,
          title: track.title ?? recording.title ?? '',
          length: track.length ?? null,
          artistCredit: artistCreditOf(track['artist-credit']),
          recording: recordingOf(recording),
        },
      ];
    }),
  );

  return {
    id: raw.id,
    title: raw.title ?? '',
    barcode: raw.barcode ?? null,
    date: raw.date ?? null,
    country: raw.country ?? null,
    urlRelations: releaseUrlRelations(raw.relations),
    artistCredit: artistCreditOf(raw['artist-credit']),
    releaseGroup: raw['release-group']
      ? { id: raw['release-group'].id, title: raw['release-group'].title }
      : null,
    media: raw.media?.length ?? 0,
    tracks,
  };
}

export async function getRecordingDetail(
  recordingId: string,
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): Promise<MbReleaseRecording | null> {
  const raw = await mbGet<RawRecording>(
    `/recording/${recordingId}?inc=work-rels+artist-rels+artist-credits+isrcs&fmt=json`,
    channel,
    onAttempt,
  );
  return raw ? recordingOf(raw) : null;
}

/** Bound to one channel so every read inherits the caller's priority. */
export function musicBrainzApi(
  channel: MusicBrainzChannel = DEFAULT_CHANNEL,
  onAttempt?: OnMbAttempt,
): MusicBrainzSource {
  return {
    name: `musicbrainz-api:${channel}`,
    releasesByBarcode: (barcode) => findReleasesByBarcode(barcode, channel, onAttempt),
    searchReleases: (title, trackCount) =>
      searchReleasesByTitle(title, trackCount, channel, onAttempt),
    releaseWithRecordings: (releaseId) => getReleaseWithRecordings(releaseId, channel, onAttempt),
    releaseRecordingIds: (releaseId) => getReleaseRecordingIds(releaseId, channel, onAttempt),
    recordingsByIsrc: (isrcs) => findRecordingsByIsrcs(isrcs, channel, onAttempt),
    recordingWorks: (recordingId) => getRecordingWorks(recordingId, channel, onAttempt),
    recordingDetail: (recordingId) => getRecordingDetail(recordingId, channel, onAttempt),
    work: (workId) => getWork(workId, channel, onAttempt),
    artist: (artistId) => getArtist(artistId, channel, onAttempt),
  };
}

/**
 * Spotify often has several pages for one composer (Beethoven has three), and MusicBrainz links
 * each.
 */
export function spotifyArtistIdsOf(artist: MbArtist): string[] {
  const ids: string[] = [];
  for (const relation of artist.relations ?? []) {
    if (relation.ended || !relation.url) continue;
    const match = /^https?:\/\/open\.spotify\.com\/artist\/([A-Za-z0-9]+)\/?$/.exec(
      relation.url.resource,
    );
    if (match) ids.push(match[1]);
  }
  return ids;
}

export type MbWorkPart = MbWorkRef & { orderingKey: number | null };

// MusicBrainz puts the position on the child's side, so a child fetch answers both without fetching
// the parent.
export function parentPartOf(work: MbWork): MbWorkPart | null {
  for (const relation of work.relations ?? []) {
    if (relation.type === 'parts' && relation.direction === 'backward' && relation.work) {
      return {
        id: relation.work.id,
        title: relation.work.title,
        orderingKey: relation['ordering-key'] ?? null,
      };
    }
  }
  return null;
}

export function childPartsOf(work: MbWork): MbWorkPart[] {
  const parts: MbWorkPart[] = [];
  for (const relation of work.relations ?? []) {
    if (relation.type === 'parts' && relation.direction === 'forward' && relation.work) {
      parts.push({
        id: relation.work.id,
        title: relation.work.title,
        orderingKey: relation['ordering-key'] ?? null,
      });
    }
  }
  return parts;
}

// MusicBrainz marks completers as `additional` composers (Süßmayr on the Requiem) and returns
// relations unordered. A composer without that mark wins; when every credit carries it, the first
// is still a real credit. The exception is a recomposition: an arrangement of another work whose
// arranger is also an additional composer (Richter's Four Seasons) is the arranger's piece.
export function composerOf(work: MbWork): { id: string; name: string } | null {
  const relations = work.relations ?? [];
  const credits = relations.filter((relation) => relation.type === 'composer' && relation.artist);
  const isArrangement = relations.some(
    (relation) => relation.type === 'arrangement' && relation.direction === 'backward',
  );
  const arrangerIds = relations
    .filter((relation) => relation.type === 'arranger')
    .map((relation) => relation.artist?.id);
  const main =
    (isArrangement && credits.find((relation) => arrangerIds.includes(relation.artist!.id))) ||
    credits.find((relation) => !relation.attributes?.includes('additional'));
  return (main ?? credits[0])?.artist ?? null;
}

// Only Catalogue-type series: Bach's orchestral suites sit in a "Work series" numbered 1-4, which
// is not a catalogue number.
export function cataloguesOf(work: MbWork): { seriesId: string; system: string; number: string }[] {
  const catalogues: { seriesId: string; system: string; number: string }[] = [];
  for (const relation of work.relations ?? []) {
    const series = relation.series;
    if (!series || relation.type !== 'part of' || series.type !== 'Catalogue') continue;
    const number = relation['attribute-values']?.number?.trim();
    if (!number) continue;
    catalogues.push({ seriesId: series.id, system: series.name, number });
  }
  return catalogues;
}

export function yearOf(value: string | null | undefined): number | null {
  const match = /^(\d{4})/.exec(value ?? '');
  return match ? Number(match[1]) : null;
}
