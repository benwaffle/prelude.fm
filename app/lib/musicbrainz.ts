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
