/**
 * A small, polite MusicBrainz web-service client.
 *
 * MusicBrainz asks anonymous clients for at most one request per second and a
 * User-Agent that identifies the application and a way to contact us. Both are
 * conditions of use rather than suggestions, so the rate limit is enforced here
 * by serialising every request through one queue: callers cannot accidentally
 * exceed it by running lookups concurrently.
 */

const BASE = 'https://musicbrainz.org/ws/2';
const MIN_INTERVAL_MS = 1_100;
const MAX_ATTEMPTS = 6;

const contact = process.env.MUSICBRAINZ_CONTACT ?? 'https://prelude.fm';
const userAgent = `PreludeFM/0.1 ( ${contact} )`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let tail: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/** Serialise onto a single queue so the one-request-per-second rule holds globally. */
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const result = tail.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return run();
  });
  // Keep the chain alive even when a caller's promise rejects.
  tail = result.catch(() => undefined);
  return result;
}

export class MusicBrainzError extends Error {}

/**
 * GET a web-service path. Returns null for 404 (the entity is genuinely absent),
 * throws for anything we could not resolve after retrying.
 *
 * MusicBrainz answers 503 with a "server is busy" body under load, and it does
 * so often enough that treating it as fatal would abort long backfills
 * needlessly, so it is retried with a backoff.
 */
export async function mbGet<T>(path: string): Promise<T | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await enqueue(() =>
      fetch(`${BASE}${path}`, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } }),
    );

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

/* ---------------------------------------------------------------- types --- */

export type MbRelation = {
  type: string;
  direction: 'forward' | 'backward';
  'attribute-values'?: Record<string, string>;
  work?: { id: string; title: string };
  artist?: { id: string; name: string };
  series?: { id: string; name: string; type?: string };
};

export type MbWork = {
  id: string;
  title: string;
  type?: string | null;
  relations?: MbRelation[];
};

export type MbArtist = {
  id: string;
  name: string;
  type?: string | null;
  'life-span'?: { begin?: string | null; end?: string | null };
};

export type MbRecordingSearchHit = {
  id: string;
  title: string;
  score?: number;
  isrcs?: string[];
};

/* ------------------------------------------------------------- lookups --- */

/**
 * Resolve many ISRCs at once.
 *
 * The per-ISRC endpoint would need one request each, which is hours for a
 * library of this size. The search index accepts a Lucene OR over ISRCs and
 * echoes each hit's full `isrcs` list, so a batch can be mapped back to the
 * ISRCs that produced it.
 *
 * Only ISRCs we asked for are returned; a recording carrying extra ISRCs does
 * not cause those to be claimed.
 */
export async function findRecordingsByIsrcs(isrcs: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (isrcs.length === 0) return found;

  const wanted = new Set(isrcs);
  const query = isrcs.map((isrc) => `isrc:${isrc}`).join(' OR ');
  const result = await mbGet<{ recordings?: MbRecordingSearchHit[] }>(
    `/recording?query=${encodeURIComponent(query)}&fmt=json&limit=100`,
  );

  for (const recording of result?.recordings ?? []) {
    for (const isrc of recording.isrcs ?? []) {
      if (wanted.has(isrc) && !found.has(isrc)) found.set(isrc, recording.id);
    }
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
export async function findReleasesByBarcode(barcode: string): Promise<string[]> {
  const normalise = (value: string | null | undefined) => (value ?? '').trim().replace(/^0+/, '');
  const wanted = normalise(barcode);
  if (!wanted) return [];

  const result = await mbGet<{ releases?: { id: string; barcode?: string | null }[] }>(
    `/release?query=barcode:${encodeURIComponent(wanted)}&fmt=json&limit=25`,
  );
  return (result?.releases ?? [])
    .filter((release) => normalise(release.barcode) === wanted)
    .map((release) => release.id);
}

/** The works a recording is a performance of. */
export async function getRecordingWorks(
  recordingId: string,
): Promise<{ id: string; title: string }[]> {
  const recording = await mbGet<{ relations?: MbRelation[] }>(
    `/recording/${recordingId}?inc=work-rels&fmt=json`,
  );
  const works: { id: string; title: string }[] = [];
  for (const relation of recording?.relations ?? []) {
    if (relation.type === 'performance' && relation.work) works.push(relation.work);
  }
  return works;
}

export async function getWork(workId: string): Promise<MbWork | null> {
  return mbGet<MbWork>(`/work/${workId}?inc=work-rels+artist-rels+series-rels&fmt=json`);
}

export async function getArtist(artistId: string): Promise<MbArtist | null> {
  return mbGet<MbArtist>(`/artist/${artistId}?fmt=json`);
}

/* ------------------------------------------------------ relation readers --- */

/** The parent work this one is a movement/section of, if any. */
export function parentWorkOf(work: MbWork): { id: string; title: string } | null {
  for (const relation of work.relations ?? []) {
    if (relation.type === 'parts' && relation.direction === 'backward' && relation.work) {
      return relation.work;
    }
  }
  return null;
}

/** Child parts, in the order MusicBrainz returned them. */
export function childPartsOf(work: MbWork): { id: string; title: string }[] {
  const parts: { id: string; title: string }[] = [];
  for (const relation of work.relations ?? []) {
    if (relation.type === 'parts' && relation.direction === 'forward' && relation.work) {
      parts.push(relation.work);
    }
  }
  return parts;
}

export function composerOf(work: MbWork): { id: string; name: string } | null {
  for (const relation of work.relations ?? []) {
    if (relation.type === 'composer' && relation.artist) return relation.artist;
  }
  return null;
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
