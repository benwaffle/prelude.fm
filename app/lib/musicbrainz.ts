/**
 * The MusicBrainz web service, as a `MusicBrainzSource`.
 *
 * Every request here goes through `musicbrainz-gateway.ts`, which owns the one
 * request per second MusicBrainz allows us and decides whose turn it is. This
 * module is only about what to ask for and how to read the answer.
 */
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

/**
 * The channel a bare call counts against.
 *
 * `backfill` is the safe default: it is the lowest-priority read channel, so
 * forgetting to say what a call is for makes it wait rather than jump a queue
 * somebody is sitting in front of.
 */
const DEFAULT_CHANNEL: MusicBrainzChannel = 'backfill';

export class MusicBrainzError extends Error {}

/** Told of every request actually sent, retries included, for a caller that counts them. */
export type OnMbAttempt = () => void;

/**
 * GET a web-service path. Returns null for 404 (the entity is genuinely absent),
 * throws for anything we could not resolve after retrying.
 *
 * MusicBrainz answers 503 with a "server is busy" body under load, and it does
 * so often enough that treating it as fatal would abort long backfills
 * needlessly, so it is retried with a backoff. Each attempt is a fresh trip
 * through the gateway, so retries queue like anything else and are counted
 * against the day's budget — a retry is a request the server had to serve.
 * `onAttempt` hears about each of them for the same reason.
 */
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

/* ------------------------------------------------------------- lookups --- */

/**
 * A value as one quoted Lucene term. Quotes and backslashes are the only
 * characters that end or escape a phrase, so they become spaces; null when
 * nothing is left to search for.
 */
export function luceneQuote(value: string): string | null {
  const cleaned = value.replace(/["\\]/g, ' ').trim();
  return cleaned ? `"${cleaned}"` : null;
}

/** One ISRC we asked for, and a recording the search index says carries it. */
export type MbIsrcHit = { isrc: string; recording: MbRecordingSearchHit };

/**
 * Every recording carrying any of these ISRCs, in one search.
 *
 * The per-ISRC endpoint would need one request each, which is hours for a
 * library of this size. The search index accepts a Lucene OR over ISRCs and
 * echoes each hit's full `isrcs` list, so a batch can be mapped back to the
 * ISRCs that produced it.
 *
 * Only ISRCs we asked for are returned; a recording carrying extra ISRCs does
 * not cause those to be claimed. An ISRC on several recordings is a hit for
 * each.
 */
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

/** Each ISRC's first recording, for a caller that needs one answer per ISRC. */
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

/**
 * Releases carrying a barcode, filtered to exact matches.
 *
 * The search index is fuzzy and will return near misses, so results whose own
 * barcode differs are dropped: a near miss here would attach an album to the
 * wrong release. Leading zeros are ignored, since UPC-12 and EAN-13 write the
 * same barcode with different padding.
 */
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

/**
 * Releases with this title and exactly this many tracks.
 *
 * This is the route to releases MusicBrainz holds without a barcode, which
 * sampling suggests is a real share of the albums currently filed as absent.
 * The search is fuzzy by design, so it only produces a shortlist — the caller
 * confirms each candidate against the album's durations before believing it.
 */
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

/**
 * The recordings a release contains, in order.
 *
 * Used to decide whether releases sharing a barcode actually differ. A record
 * issued in two territories is two releases in MusicBrainz and one set of
 * recordings, so for anything addressed to recordings — ISRCs above all — the
 * two are interchangeable and the barcode is not really ambiguous at all.
 */
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

/** The works a recording is a performance of. */
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

/* --------------------------------------------------- the release read --- */

/**
 * Everything one release can tell us, in one request.
 *
 * This single `inc` list returns the tracklist, each track's recording, its
 * ISRCs, the works those recordings perform, the artists credited on them
 * with their roles, and the release's group. Asking per recording instead
 * would cost one request each — dozens for an album — and the difference
 * between those two shapes is what decides whether the rate-limited web
 * service is usable at all.
 */
const RELEASE_INC =
  'recordings+recording-level-rels+work-rels+artist-rels+artist-credits+isrcs+url-rels+release-groups';

/** An `artist-credit` list as the web service returns it. */
export type MbArtistCreditJson = { name?: string; artist?: { id: string; name: string } }[];

/** The artists of a credit, under the names the credit prints. */
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

/**
 * Artist credits on a recording.
 *
 * An instrument relationship names the instrument in its attributes — a
 * violinist is `instrument` + `violin`, not a role called `violin` — so the
 * attribute is only read as an instrument for the relationship types that use
 * it that way. `engineer` also carries attributes (`assistant`), and reading
 * that as an instrument would invent a credit that does not exist.
 */
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

/** A release with the credits `MbRelease` leaves out: its own, its group's and each track's. */
export type MbReleaseDetail = Omit<MbRelease, 'tracks'> & {
  artistCredit: { artistId: string; name: string }[];
  releaseGroup: { id: string; title: string } | null;
  /** How many media (discs) the release has, including any without tracks. */
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

/** One recording, with the works it performs and who played on it. */
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

/* ------------------------------------------------------------- source --- */

/**
 * The web service as a `MusicBrainzSource`, bound to one channel.
 *
 * Binding the channel at construction rather than per call means the caller
 * says once what it is doing — serving a signup, sweeping the cache — and
 * every read it makes inherits the right priority.
 */
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

/* ------------------------------------------------------ relation readers --- */

/**
 * The Spotify artists a MusicBrainz artist links to. Spotify often has
 * several pages for one composer (Beethoven has three), and MusicBrainz
 * links each of them.
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

/** A work in a `parts` relationship, with its position in the parent. */
export type MbWorkPart = MbWorkRef & { orderingKey: number | null };

/** The parent work this one is a movement/section of, if any. */
export function parentWorkOf(work: MbWork): MbWorkRef | null {
  for (const relation of work.relations ?? []) {
    if (relation.type === 'parts' && relation.direction === 'backward' && relation.work) {
      return relation.work;
    }
  }
  return null;
}

/**
 * The parent work and this work's position in it.
 *
 * MusicBrainz puts the position on the child's own view of the relationship,
 * so a child fetch answers both questions at once and the parent never has to
 * be fetched just to learn what order its parts come in.
 */
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

/** Child parts with their positions, in the order MusicBrainz returned them. */
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

/**
 * The work's main composer.
 *
 * A work can credit several composers. MusicBrainz marks a completer or
 * contributor as an `additional` composer (Süßmayr on Mozart's Requiem) and
 * returns relations in no order that puts the main composer first, so taking
 * the first one can file a work under its completer. A composer without that
 * mark wins; when every credit carries it, the first is still a real credit.
 */
export function composerOf(work: MbWork): { id: string; name: string } | null {
  const credits = (work.relations ?? []).filter(
    (relation) => relation.type === 'composer' && relation.artist,
  );
  const main = credits.find((relation) => !relation.attributes?.includes('additional'));
  return (main ?? credits[0])?.artist ?? null;
}

/**
 * Catalogue references, e.g. `{ system: 'Bach-Werke-Verzeichnis', number: 'BWV 1067' }`.
 *
 * A work can also belong to non-catalogue series — Bach's orchestral suites sit
 * in a "Work series" numbered 1-4 — and reading those as catalogue numbers
 * would file the second suite under catalogue number "2". Only series whose
 * type is Catalogue are returned.
 */
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

/**
 * MusicBrainz titles a movement with its parent's title in front —
 * "Orchestersuite Nr. 2 h-Moll, BWV 1067: IV. Bourrée I/II". We store the part
 * alone, so the prefix is removed; otherwise every movement of a work would
 * repeat that work's title.
 *
 * Only an exact "<parent>:" prefix is removed. A leaf whose title merely starts
 * with similar words is left alone, because guessing here would silently
 * truncate real titles.
 */
export function stripParentPrefix(leafTitle: string, parentTitle: string | null): string {
  if (!parentTitle) return leafTitle;
  const prefix = `${parentTitle}:`;
  if (!leafTitle.startsWith(prefix)) return leafTitle;
  return leafTitle.slice(prefix.length).trim() || leafTitle;
}

/** MusicBrainz life-span dates are ISO-ish strings; we only keep the year. */
export function yearOf(value: string | null | undefined): number | null {
  const match = /^(\d{4})/.exec(value ?? '');
  return match ? Number(match[1]) : null;
}

/** One of our parts, with what MusicBrainz said about it. */
export type MatchedPart = {
  /** The MusicBrainz work this part was recorded as. */
  leafId: string;
  /** That work's parent, or the work itself when it has none. */
  parentId: string;
  /** The MusicBrainz title, with any parent prefix already removed. */
  title: string;
};

/**
 * Decide which MusicBrainz work corresponds to one of ours.
 *
 * MusicBrainz's hierarchy is deeper than ours and its depth varies, so "the
 * parent of whatever the recording performed" is not a reliable answer. The
 * Well-Tempered Clavier is a single MusicBrainz work whose parts are the
 * preludes and fugues; a track of a whole prelude-and-fugue therefore resolves
 * to a work whose parent is the entire book, while a track of just the prelude
 * resolves one level lower. Taking the parent in both cases files two dozen of
 * our works under the book.
 *
 * The rule is to find the level whose children are our parts:
 *
 * - If one matched work is the parent of the others, our parts are its
 *   movements and it is our work.
 * - If every matched work shares one parent, our parts are that parent's
 *   movements.
 * - A work with a single part is that piece, so long as MusicBrainz's title
 *   agrees. Where it does not — we hold one movement of something larger — the
 *   parent is the better answer.
 *
 * Returns null when the parts disagree, which usually means a match further
 * upstream is wrong; choosing between them would bury that.
 */
export function resolveWorkLevel(
  ourTitle: string,
  parts: MatchedPart[],
  titlesAgree: (a: string, b: string) => boolean,
): string | null {
  if (parts.length === 0) return null;

  if (parts.length === 1) {
    const [only] = parts;
    if (titlesAgree(ourTitle, only.title)) return only.leafId;
    return only.parentId === only.leafId ? null : only.parentId;
  }

  const leaves = new Set(parts.map((part) => part.leafId));
  const parents = new Set(parts.map((part) => part.parentId));

  // A matched work that is also the parent of other matched works sits exactly
  // at our level: its children are the rest of our parts.
  const ancestors = [...leaves].filter((leaf) => parents.has(leaf));
  if (ancestors.length === 1) return ancestors[0];
  if (ancestors.length > 1) return null;

  /*
   * Several of our parts all naming one MusicBrainz work means that work is
   * ours and MusicBrainz simply does not divide it further. Taking its parent
   * instead reaches for the collection above: each of Bach's eight short
   * preludes and fugues would resolve to "8 kleine Präludien und Fugen,
   * BWV 553-560", and all eight would look like the same piece as each other.
   */
  if (leaves.size === 1 && parts.length >= 2) return [...leaves][0];

  if (parents.size === 1) return [...parents][0];

  /*
   * One part naming a different work than all the others is usually a bad
   * match rather than a real disagreement: MusicBrainz carries ISRCs that
   * labels attached to the wrong recording, and a single one of those is
   * enough to break a work that is otherwise unanimous. Haydn's Symphony 87
   * loses its link to a Sony ISRC sitting on Symphony 82's finale.
   *
   * So a clear majority wins: more than half the parts, at least two of them,
   * and no tie. Anything less stays unresolved, because two parts pointing one
   * way and two the other is a real question, not an outlier.
   */
  const votes = new Map<string, number>();
  for (const part of parts) votes.set(part.parentId, (votes.get(part.parentId) ?? 0) + 1);
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [winner, count] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;
  if (count >= 2 && count > parts.length / 2 && count > runnerUp) return winner;

  return null;
}
