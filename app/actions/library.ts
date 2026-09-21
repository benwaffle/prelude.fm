'use server';

import { db } from '@/lib/db';
import {
  composer,
  work,
  workCatalogV2,
  workPartV2,
  recordingV2,
  recordingTrackV2,
  trackWorkPartV2,
  spotifyTrack,
  spotifyAlbum,
  spotifyArtist,
  trackArtists,
  mbArtist,
  mbRecordingCredit,
  mbWork,
  trackRecording,
} from '@/lib/db/schema';
import { and, eq, inArray, desc, asc, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { mappedTrackCount } from '@/lib/db/expressions';
import { parseCatalogueQuery } from '@/lib/catalogue-query';
import {
  creditLine,
  displayName,
  hasPerformingCredits,
  performingCredits,
  type PerformingCredits,
  type StoredCredit,
} from '@/lib/musicbrainz-credits';
import {
  type Era,
  catalogLabel,
  eraFor,
  formatDuration,
  lifespan,
  pickImage,
  playable,
  shortName,
  surname,
  tintFor,
  type LibraryWork,
  type Movement,
} from '@/lib/prelude';

/** libSQL takes bound parameters one at a time; keep each IN list modest. */
const CHUNK = 400;

function chunked<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function coverOf(images: { url: string }[] | null): string | null {
  return images?.[0]?.url ?? null;
}

/* =========================================================
   LIBRARY
   ========================================================= */

/**
 * Build the library view from the user's saved Spotify tracks.
 *
 * Liking is movement-level, so a work card shows every movement of the
 * recording and marks which ones the user actually saved — the unsaved
 * siblings render as ghost rows.
 */
export async function getLibraryWorks(likedTrackIds: string[]): Promise<LibraryWork[]> {
  if (likedTrackIds.length === 0) return [];
  const liked = new Set(likedTrackIds);

  // Which recordings do the saved tracks belong to?
  const recordingIds = new Set<number>();
  for (const batch of chunked(likedTrackIds)) {
    const rows = await db
      .select({ recordingId: recordingTrackV2.recordingId })
      .from(recordingTrackV2)
      .where(inArray(recordingTrackV2.spotifyTrackId, batch));
    for (const row of rows) recordingIds.add(row.recordingId);
  }
  if (recordingIds.size === 0) return [];

  return buildWorks(Array.from(recordingIds), liked);
}

/**
 * Every track of the given recordings, assembled into work cards. `liked`
 * marks the tracks the user has saved.
 */
async function buildWorks(recordingIds: number[], liked: Set<string>): Promise<LibraryWork[]> {
  type Row = (typeof rows)[number];
  const rows: {
    recordingId: number;
    workId: number;
    workTitle: string;
    nickname: string | null;
    yearComposed: number | null;
    catalogSystem: string | null;
    catalogNumber: string | null;
    composerId: number;
    composerName: string;
    birthYear: number | null;
    deathYear: number | null;
    composerArtistId: string | null;
    composerImages: { url: string; width: number; height: number }[] | null;
    albumId: string;
    albumTitle: string;
    albumImages: { url: string; width: number; height: number }[] | null;
    trackId: string | null;
    trackTitle: string | null;
    discNumber: number | null;
    trackNumber: number | null;
    durationMs: number | null;
    partPosition: number | null;
    partLabel: string | null;
    partTitle: string | null;
  }[] = [];

  for (const batch of chunked(recordingIds)) {
    const found = await db
      .select({
        recordingId: recordingV2.id,
        workId: work.id,
        workTitle: work.title,
        nickname: work.nickname,
        yearComposed: work.yearComposed,
        catalogSystem: workCatalogV2.system,
        catalogNumber: workCatalogV2.number,
        composerId: composer.id,
        composerName: composer.name,
        birthYear: composer.birthYear,
        deathYear: composer.deathYear,
        composerArtistId: composer.spotifyArtistId,
        composerImages: spotifyArtist.images,
        albumId: spotifyAlbum.spotifyId,
        albumTitle: spotifyAlbum.title,
        albumImages: spotifyAlbum.images,
        trackId: spotifyTrack.spotifyId,
        trackTitle: spotifyTrack.title,
        discNumber: spotifyTrack.discNumber,
        trackNumber: spotifyTrack.trackNumber,
        durationMs: spotifyTrack.durationMs,
        partPosition: workPartV2.position,
        partLabel: workPartV2.label,
        partTitle: workPartV2.title,
      })
      .from(recordingV2)
      .innerJoin(work, eq(recordingV2.workId, work.id))
      .innerJoin(composer, eq(work.composerId, composer.id))
      // Left, because 60 composers have no linked Spotify artist to portray.
      .leftJoin(spotifyArtist, eq(spotifyArtist.spotifyId, composer.spotifyArtistId))
      .innerJoin(spotifyAlbum, eq(recordingV2.spotifyAlbumId, spotifyAlbum.spotifyId))
      .leftJoin(recordingTrackV2, eq(recordingTrackV2.recordingId, recordingV2.id))
      .leftJoin(spotifyTrack, eq(recordingTrackV2.spotifyTrackId, spotifyTrack.spotifyId))
      .leftJoin(trackWorkPartV2, eq(trackWorkPartV2.spotifyTrackId, spotifyTrack.spotifyId))
      .leftJoin(workPartV2, eq(trackWorkPartV2.workPartId, workPartV2.id))
      .leftJoin(
        workCatalogV2,
        and(eq(workCatalogV2.workId, work.id), eq(workCatalogV2.isPrimary, true)),
      )
      .where(inArray(recordingV2.id, batch));
    rows.push(...found);
  }
  if (rows.length === 0) return [];

  const trackIds = rows
    .map((r) => r.trackId)
    .filter((trackId): trackId is string => trackId !== null);
  const [performers, mbCredits] = await Promise.all([
    performersFor(trackIds),
    musicbrainzCreditsFor(trackIds),
  ]);
  const allParts = await partsForWorks(rows.map((r) => r.workId));

  // A track can carry more than one movement, so collapse part rows per track.
  const byRecording = new Map<number, { head: Row; tracks: Map<string, Row[]> }>();
  for (const row of rows) {
    let entry = byRecording.get(row.recordingId);
    if (!entry) {
      entry = { head: row, tracks: new Map() };
      byRecording.set(row.recordingId, entry);
    }
    if (row.trackId !== null) {
      const parts = entry.tracks.get(row.trackId);
      if (parts) parts.push(row);
      else entry.tracks.set(row.trackId, [row]);
    }
  }

  const works: LibraryWork[] = [];
  for (const [recordingId, { head, tracks }] of byRecording) {
    const trackRows = Array.from(tracks.values()).sort((a, b) => {
      const x = a[0];
      const y = b[0];
      return (
        (x.discNumber ?? Number.MAX_SAFE_INTEGER) - (y.discNumber ?? Number.MAX_SAFE_INTEGER) ||
        (x.trackNumber ?? Number.MAX_SAFE_INTEGER) - (y.trackNumber ?? Number.MAX_SAFE_INTEGER)
      );
    });

    const present: Movement[] = trackRows.map((parts, trackIndex) => {
      const mapped = parts
        .filter((part): part is Row & { partPosition: number } => part.partPosition !== null)
        .sort((a, b) => a.partPosition - b.partPosition);
      const head = parts[0];
      const { numeral, name, unnamed } =
        mapped.length > 0
          ? labelMovement(mapped, head.trackTitle ?? '')
          : { numeral: '', name: head.trackTitle ?? 'Metadata missing', unnamed: true };
      return {
        n: 0,
        position: mapped[0]?.partPosition ?? trackIndex + 1,
        roman: numeral,
        name,
        unnamed,
        missing: false,
        durationMs: head.durationMs,
        duration: head.durationMs === null ? null : formatDuration(head.durationMs),
        liked: head.trackId !== null && liked.has(head.trackId),
        trackId: head.trackId,
        uri: head.trackId === null ? null : `spotify:track:${head.trackId}`,
      };
    });

    /*
     * A recording often covers only some of a work — one movement lifted onto
     * a compilation, say. Carry the parts it lacks into the list as greyed-out
     * rows so the programme shows what's absent instead of reading as a short
     * work.
     */
    const covered = new Set<number>();
    for (const parts of trackRows) {
      for (const part of parts) if (part.partPosition !== null) covered.add(part.partPosition);
    }

    const showCanonicalGaps = trackRows.length === 0 || covered.size > 0;
    const gaps: Movement[] = (showCanonicalGaps ? (allParts.get(head.workId) ?? []) : [])
      .filter((part) => !covered.has(part.position))
      .map((part) => {
        const { numeral, name } = labelMovement(
          [{ ...part, partPosition: part.position }],
          // No track means no Spotify title to fall back on; the part's own
          // metadata is all we have to name it with.
          '',
        );
        return {
          n: 0,
          position: part.position,
          roman: numeral,
          name: name || 'Metadata missing',
          unnamed: !name,
          missing: true,
          durationMs: null,
          duration: null,
          liked: false,
          trackId: null,
          uri: null,
        };
      });

    const movements = [...present, ...gaps]
      .sort((a, b) => a.position - b.position)
      .map((m, index) => ({ ...m, n: index + 1 }));

    const credited = creditsFor(
      trackRows.flatMap((parts) => (parts[0].trackId === null ? [] : [parts[0].trackId])),
      performers,
      head.composerArtistId,
      mbCredits,
    );
    const { tint, ink } = tintFor(head.albumId);

    works.push({
      id: `${head.workId}:${recordingId}`,
      workId: head.workId,
      recordingId,
      composer: shortName(head.composerName),
      composerFull: head.composerName,
      composerId: head.composerId,
      composerImage: pickImage(head.composerImages, 320),
      era: eraFor(head.birthYear),
      years: lifespan(head.birthYear, head.deathYear),
      title: head.workTitle,
      nickname: head.nickname,
      catalog: catalogLabel(head.catalogSystem, head.catalogNumber),
      year: head.yearComposed,
      performer: credited.performer,
      ensemble: credited.ensemble,
      album: head.albumTitle,
      cover: coverOf(head.albumImages),
      tint,
      ink,
      movements,
      unmatched: covered.size === 0,
      // Only the client knows when a track was saved; the library context fills this in.
      addedAt: null,
    });
  }

  return works;
}

/**
 * Split a movement into the numeral column and the name beside it.
 *
 * `work_part_v2.label` usually already holds the numeral ("VIII"), so folding
 * it into the name the way `formatWorkPart` does would double-number a layout
 * that numbers in its own column. Where a part carries only a label and no
 * title, that label *is* the name and the numeral column stays empty.
 */
function labelMovement(
  parts: { partLabel: string | null; partTitle: string | null; partPosition: number }[],
  trackTitle: string,
): { numeral: string; name: string; unnamed: boolean } {
  const titles = parts.map((p) => p.partTitle?.trim()).filter((t): t is string => Boolean(t));
  const label = parts[0].partLabel?.trim() ?? '';

  // The numeral column is 22px wide — sized for "VIII.", not "No. 3.", which
  // wraps. Reduce a numeral-ish label to just its number.
  const compact = label.match(/^(?:nos?\.?\s*)?([ivxlcdm]+|\d+)\s*\.?$/i)?.[1] ?? '';

  if (titles.length > 0) {
    return { numeral: compact, name: titles.join(' / '), unnamed: false };
  }
  if (label) {
    return { numeral: '', name: label, unnamed: false };
  }
  /*
   * 261 parts carry neither a label nor a title. Naming one "Movement 3" would
   * read as real metadata; show Spotify's own track title instead and flag it,
   * so the screen says out loud that the parser got nothing here.
   */
  return { numeral: '', name: trackTitle, unnamed: true };
}

/** workId -> every part of that work, so we can see what a recording lacks. */
async function partsForWorks(
  workIds: number[],
): Promise<
  Map<number, { position: number; partLabel: string | null; partTitle: string | null }[]>
> {
  const unique = Array.from(new Set(workIds));
  const byWork = new Map<
    number,
    { position: number; partLabel: string | null; partTitle: string | null }[]
  >();
  for (const batch of chunked(unique)) {
    const rows = await db
      .select({
        workId: workPartV2.workId,
        position: workPartV2.position,
        partLabel: workPartV2.label,
        partTitle: workPartV2.title,
      })
      .from(workPartV2)
      .where(inArray(workPartV2.workId, batch));
    for (const row of rows) {
      const list = byWork.get(row.workId) ?? [];
      list.push({ position: row.position, partLabel: row.partLabel, partTitle: row.partTitle });
      byWork.set(row.workId, list);
    }
  }
  return byWork;
}

/** trackId -> ordered artist names. */
async function performersFor(
  trackIds: string[],
): Promise<Map<string, { id: string; name: string }[]>> {
  const unique = Array.from(new Set(trackIds));
  const byTrack = new Map<string, { id: string; name: string }[]>();
  for (const batch of chunked(unique)) {
    const rows = await db
      .select({
        trackId: trackArtists.spotifyTrackId,
        artistId: spotifyArtist.spotifyId,
        name: spotifyArtist.name,
      })
      .from(trackArtists)
      .innerJoin(spotifyArtist, eq(trackArtists.spotifyArtistId, spotifyArtist.spotifyId))
      .where(inArray(trackArtists.spotifyTrackId, batch));
    for (const row of rows) {
      const list = byTrack.get(row.trackId) ?? [];
      list.push({ id: row.artistId, name: row.name });
      byTrack.set(row.trackId, list);
    }
  }
  return byTrack;
}

/**
 * trackId -> what MusicBrainz says about who played on that recording.
 *
 * Only tracks anchored to a recording appear. Names prefer what a release
 * credited the artist as, because MusicBrainz files an artist under their own
 * script and the credited name is the Latin form the label printed.
 */
async function musicbrainzCreditsFor(trackIds: string[]): Promise<Map<string, PerformingCredits>> {
  const unique = Array.from(new Set(trackIds));
  const byTrack = new Map<string, PerformingCredits>();
  if (unique.length === 0) return byTrack;

  const raw = new Map<string, StoredCredit[]>();
  for (const batch of chunked(unique)) {
    const rows = await db
      .select({
        trackId: trackRecording.spotifyTrackId,
        artistMbid: mbRecordingCredit.artistMbid,
        name: mbArtist.name,
        creditedName: mbArtist.creditedName,
        role: mbRecordingCredit.role,
        instrument: mbRecordingCredit.instrument,
      })
      .from(trackRecording)
      .innerJoin(
        mbRecordingCredit,
        eq(mbRecordingCredit.recordingMbid, trackRecording.recordingMbid),
      )
      .innerJoin(mbArtist, eq(mbArtist.mbid, mbRecordingCredit.artistMbid))
      .where(inArray(trackRecording.spotifyTrackId, batch));

    for (const row of rows) {
      const printed = displayName(row);
      if (!printed) continue;
      const list = raw.get(row.trackId) ?? [];
      list.push({
        artistMbid: row.artistMbid,
        name: printed,
        role: row.role,
        instrument: row.instrument,
      });
      raw.set(row.trackId, list);
    }
  }

  for (const [trackId, credits] of raw) byTrack.set(trackId, performingCredits(credits));
  return byTrack;
}

/**
 * The design credits a recording as "performer · ensemble".
 *
 * MusicBrainz states the roles outright — soloist, conductor, orchestra — so
 * it answers wherever it reaches. Where it does not, Spotify's flat artist
 * list is all there is, and the fallback takes the most frequently credited
 * non-composer artists across the recording and reads the first two.
 *
 * MusicBrainz only gets to replace that line, never to blank it: a recording
 * it holds but credits to nobody would otherwise turn a real name into an
 * empty slot.
 *
 * Some records credit nobody but the composer — a film composer conducting
 * their own score, say. There the composer *is* the performing credit, so fall
 * back to the full list rather than claiming the performer is unknown.
 */
function creditsFor(
  trackIds: string[],
  performers: Map<string, { id: string; name: string }[]>,
  composerArtistId: string | null,
  musicbrainz?: Map<string, PerformingCredits>,
): { performer: string | null; ensemble: string | null } {
  for (const trackId of trackIds) {
    const credits = musicbrainz?.get(trackId);
    if (credits && hasPerformingCredits(credits)) return creditLine(credits);
  }

  const rank = (excludeComposer: boolean) => {
    const counts = new Map<string, number>();
    for (const trackId of trackIds) {
      for (const artist of performers.get(trackId) ?? []) {
        if (excludeComposer && composerArtistId && artist.id === composerArtistId) continue;
        counts.set(artist.name, (counts.get(artist.name) ?? 0) + 1);
      }
    }
    return Array.from(counts, ([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  };

  const ranked = rank(true);
  if (ranked.length > 0) {
    return { performer: ranked[0].name, ensemble: ranked[1]?.name ?? null };
  }
  const withComposer = rank(false);
  return { performer: withComposer[0]?.name ?? null, ensemble: null };
}

/* =========================================================
   RECORDING DETAIL
   ========================================================= */

export interface OtherRecording {
  recordingId: number;
  albumId: string;
  album: string;
  cover: string | null;
  year: number | null;
  performer: string | null;
  ensemble: string | null;
  durationMs: number | null;
  duration: string | null;
  unmatched: boolean;
  popularity: number | null;
  tint: string;
}

export interface WorkSummary {
  workId: number;
  recordingId: number;
  title: string;
  nickname: string | null;
  catalog: string | null;
  year: number | null;
  cover: string | null;
  album: string | null;
  performer: string | null;
  ensemble: string | null;
  /** Movements this recording actually carries. */
  movementCount: number;
  /** Parts the work has in total, including ones this recording lacks. */
  partCount: number;
  /** The recording's tracks were never matched to movements. */
  unmatched: boolean;
  movements: { roman: string; name: string; duration: string | null; missing: boolean }[];
}

export interface WorkDetail {
  work: LibraryWork;
  others: OtherRecording[];
  moreByComposer: WorkSummary[];
}

/**
 * One recording in full, plus the two neighbourhoods the design puts under
 * it: other recordings of the same work, and other works by the composer.
 */
export async function getWorkDetail(
  workId: number,
  recordingId: number | null,
  likedTrackIds: string[] = [],
): Promise<WorkDetail | null> {
  const recordings = await db
    .select({
      id: recordingV2.id,
      popularity: recordingV2.popularity,
      mappedTracks: mappedTrackCount,
    })
    .from(recordingV2)
    .where(eq(recordingV2.workId, workId))
    .orderBy(desc(mappedTrackCount), desc(recordingV2.popularity));
  if (recordings.length === 0) return null;

  const requested =
    recordingId === null ? undefined : recordings.find((r) => r.id === recordingId)?.id;
  const chosen = requested ?? recordings[0].id;

  // Turso is a network hop away, so run the three independent branches at
  // once rather than paying for them end to end.
  const [[built], others, composerId] = await Promise.all([
    buildWorks([chosen], new Set(likedTrackIds)),
    recordingSummaries(recordings.filter((r) => r.id !== chosen).map((r) => r.id)),
    db
      .select({ composerId: work.composerId })
      .from(work)
      .where(eq(work.id, workId))
      .limit(1)
      .then((rows) => rows[0]?.composerId ?? null),
  ]);
  if (!built || composerId === null) return null;

  const moreByComposer = await worksByComposer(composerId, workId);

  return { work: built, others, moreByComposer };
}

/** Album-level cards for the "other recordings" row. */
async function recordingSummaries(recordingIds: number[]): Promise<OtherRecording[]> {
  if (recordingIds.length === 0) return [];

  const rows = await db
    .select({
      recordingId: recordingV2.id,
      popularity: recordingV2.popularity,
      albumId: spotifyAlbum.spotifyId,
      album: spotifyAlbum.title,
      albumYear: spotifyAlbum.year,
      images: spotifyAlbum.images,
      trackId: spotifyTrack.spotifyId,
      durationMs: spotifyTrack.durationMs,
      composerArtistId: composer.spotifyArtistId,
      mappedTrackCount,
    })
    .from(recordingV2)
    .innerJoin(spotifyAlbum, eq(recordingV2.spotifyAlbumId, spotifyAlbum.spotifyId))
    .leftJoin(recordingTrackV2, eq(recordingTrackV2.recordingId, recordingV2.id))
    .leftJoin(spotifyTrack, eq(recordingTrackV2.spotifyTrackId, spotifyTrack.spotifyId))
    .innerJoin(work, eq(recordingV2.workId, work.id))
    .innerJoin(composer, eq(work.composerId, composer.id))
    .where(inArray(recordingV2.id, recordingIds.slice(0, CHUNK)));

  const trackIds = rows
    .map((r) => r.trackId)
    .filter((trackId): trackId is string => trackId !== null);
  const [performers, mbCredits] = await Promise.all([
    performersFor(trackIds),
    musicbrainzCreditsFor(trackIds),
  ]);

  const byRecording = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = byRecording.get(row.recordingId) ?? [];
    list.push(row);
    byRecording.set(row.recordingId, list);
  }

  const summaries: OtherRecording[] = [];
  for (const [recordingId, list] of byRecording) {
    const head = list[0];
    // A recording's running time is the sum of its distinct tracks.
    const seen = new Set<string>();
    let durationMs = 0;
    for (const row of list) {
      if (row.trackId === null || row.durationMs === null || seen.has(row.trackId)) continue;
      seen.add(row.trackId);
      durationMs += row.durationMs;
    }
    const credited = creditsFor(Array.from(seen), performers, head.composerArtistId, mbCredits);
    summaries.push({
      recordingId,
      albumId: head.albumId,
      album: head.album,
      cover: coverOf(head.images),
      year: head.albumYear,
      performer: credited.performer,
      ensemble: credited.ensemble,
      durationMs: seen.size > 0 ? durationMs : null,
      duration: seen.size > 0 ? formatDuration(durationMs) : null,
      unmatched: Number(head.mappedTrackCount) === 0,
      popularity: head.popularity,
      tint: tintFor(head.albumId).tint,
    });
  }

  return summaries.sort(
    (a, b) => (b.popularity ?? -1) - (a.popularity ?? -1) || (a.year ?? 0) - (b.year ?? 0),
  );
}

/** "More by …" — the composer's other works, each with its fullest recording. */
async function worksByComposer(composerId: number, excludeWorkId: number): Promise<WorkSummary[]> {
  /*
   * How many of a recording's tracks are actually mapped to movements. Ranking
   * on this first matters because `recording_v2.popularity` is null across
   * whole composers, which makes "the most popular recording" arbitrary — and
   * landing on a recording with no mapped tracks used to drop the work from
   * this list entirely.
   */
  const works = await db
    .select({
      workId: work.id,
      title: work.title,
      nickname: work.nickname,
      yearComposed: work.yearComposed,
      catalogSystem: workCatalogV2.system,
      catalogNumber: workCatalogV2.number,
      recordingId: recordingV2.id,
      popularity: recordingV2.popularity,
      mappedTracks: mappedTrackCount,
    })
    .from(work)
    .innerJoin(recordingV2, eq(recordingV2.workId, work.id))
    .leftJoin(
      workCatalogV2,
      and(eq(workCatalogV2.workId, work.id), eq(workCatalogV2.isPrimary, true)),
    )
    .where(eq(work.composerId, composerId))
    .orderBy(desc(mappedTrackCount), desc(recordingV2.popularity));

  /*
   * Choosing the fullest recording to represent a work is a choice between two
   * real values, so it's fair. Choosing which *works* to show is not: with
   * popularity unpopulated there is no prominence signal, so order by year and
   * title — dull, but it doesn't pretend to rank. Works whose recordings have
   * no matched tracks stay in the list and say so.
   */
  const best = new Map<number, (typeof works)[number]>();
  for (const row of works) {
    if (row.workId === excludeWorkId) continue;
    if (!best.has(row.workId)) best.set(row.workId, row);
  }

  const top = Array.from(best.values())
    .sort(
      (a, b) =>
        (a.yearComposed ?? Number.MAX_SAFE_INTEGER) - (b.yearComposed ?? Number.MAX_SAFE_INTEGER) ||
        a.title.localeCompare(b.title, 'en'),
    )
    .slice(0, 6);
  if (top.length === 0) return [];

  const built = await buildWorks(
    top.filter((w) => Number(w.mappedTracks) > 0).map((w) => w.recordingId),
    new Set(),
  );
  const byRecording = new Map(built.map((w) => [w.recordingId, w]));

  return top.map((row) => {
    const full = byRecording.get(row.recordingId);
    return {
      workId: row.workId,
      recordingId: row.recordingId,
      title: row.title,
      nickname: row.nickname,
      catalog: catalogLabel(row.catalogSystem, row.catalogNumber),
      year: row.yearComposed,
      cover: full?.cover ?? null,
      album: full?.album ?? null,
      performer: full?.performer ?? null,
      ensemble: full?.ensemble ?? null,
      // Count what the recording actually carries, not the work's full length.
      movementCount: full ? playable(full.movements).length : 0,
      partCount: full?.movements.length ?? 0,
      // No movements means the recording's tracks were never matched. Say that
      // on the card rather than dropping the work.
      unmatched: full === undefined,
      movements: (full?.movements ?? []).slice(0, 4).map((m) => ({
        roman: m.roman,
        name: m.name,
        missing: m.missing,
        duration: m.duration,
      })),
    } satisfies WorkSummary;
  });
}

/* =========================================================
   CATALOGUE
   ========================================================= */

export interface CatalogComposer {
  id: number;
  name: string;
  short: string;
  sort: string;
  era: Era | null;
  born: number | null;
  died: number | null;
  years: string;
  /** The composer's Spotify artist portrait, when we have one. */
  image: string | null;
  workCount: number;
  recordingCount: number;
}

export interface CatalogWork {
  id: number;
  title: string;
  nickname: string | null;
  catalog: string | null;
  year: number | null;
  /** null when `work.form` is unrecorded. */
  genre: string | null;
  movementCount: number;
  recordingCount: number;
}

export interface CatalogRecording {
  id: number;
  album: string;
  albumId: string;
  cover: string | null;
  year: number | null;
  performer: string | null;
  ensemble: string | null;
  duration: string | null;
  popularity: number | null;
  tint: string;
  /** How many movements of this recording the user has saved. */
  liked: number;
  firstTrackUri: string | null;
  /** This recording has no tracks mapped to canonical work parts. */
  unmatched: boolean;
}

/** Column one: every composer we hold, with what we hold of them. */
export async function getCatalogComposers(): Promise<CatalogComposer[]> {
  const rows = await db
    .select({
      id: composer.id,
      name: composer.name,
      birthYear: composer.birthYear,
      deathYear: composer.deathYear,
      images: spotifyArtist.images,
      workCount: sql<number>`count(distinct ${work.id})`,
      recordingCount: sql<number>`count(distinct ${recordingV2.id})`,
    })
    .from(composer)
    .leftJoin(work, eq(work.composerId, composer.id))
    .leftJoin(recordingV2, eq(recordingV2.workId, work.id))
    // Left, because 60 composers have no linked Spotify artist to portray.
    .leftJoin(spotifyArtist, eq(spotifyArtist.spotifyId, composer.spotifyArtistId))
    .groupBy(composer.id)
    .orderBy(asc(composer.name));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    short: shortName(row.name),
    // Still filed under the surname, so Pärt sorts under P.
    sort: surname(row.name),
    era: eraFor(row.birthYear),
    born: row.birthYear,
    died: row.deathYear,
    years: lifespan(row.birthYear, row.deathYear),
    // The list renders these at 30px; no need to ship the 1000px original.
    image: pickImage(row.images, 160),
    workCount: Number(row.workCount),
    recordingCount: Number(row.recordingCount),
  }));
}

/** Column two: one composer's catalogue. */
export async function getCatalogWorks(composerId: number): Promise<CatalogWork[]> {
  const rows = await db
    .select({
      id: work.id,
      title: work.title,
      nickname: work.nickname,
      yearComposed: work.yearComposed,
      form: work.form,
      catalogSystem: workCatalogV2.system,
      catalogNumber: workCatalogV2.number,
      movementCount: sql<number>`count(distinct ${workPartV2.id})`,
      recordingCount: sql<number>`count(distinct ${recordingV2.id})`,
    })
    .from(work)
    .leftJoin(recordingV2, eq(recordingV2.workId, work.id))
    .leftJoin(workPartV2, eq(workPartV2.workId, work.id))
    .leftJoin(
      workCatalogV2,
      and(eq(workCatalogV2.workId, work.id), eq(workCatalogV2.isPrimary, true)),
    )
    .where(eq(work.composerId, composerId))
    .groupBy(work.id, workCatalogV2.system, workCatalogV2.number)
    .orderBy(asc(work.yearComposed), asc(work.title));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    nickname: row.nickname,
    catalog: catalogLabel(row.catalogSystem, row.catalogNumber),
    year: row.yearComposed,
    genre: titleCase(row.form),
    movementCount: Number(row.movementCount),
    recordingCount: Number(row.recordingCount),
  }));
}

function titleCase(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Column three: every recording of one work, most popular first. */
export async function getCatalogRecordings(
  workId: number,
  likedTrackIds: string[] = [],
): Promise<CatalogRecording[]> {
  const rows = await db
    .select({
      recordingId: recordingV2.id,
      popularity: recordingV2.popularity,
      albumId: spotifyAlbum.spotifyId,
      album: spotifyAlbum.title,
      albumYear: spotifyAlbum.year,
      images: spotifyAlbum.images,
      trackId: spotifyTrack.spotifyId,
      discNumber: spotifyTrack.discNumber,
      trackNumber: spotifyTrack.trackNumber,
      durationMs: spotifyTrack.durationMs,
      composerArtistId: composer.spotifyArtistId,
      mappedTrackCount,
    })
    .from(recordingV2)
    .innerJoin(spotifyAlbum, eq(recordingV2.spotifyAlbumId, spotifyAlbum.spotifyId))
    .leftJoin(recordingTrackV2, eq(recordingTrackV2.recordingId, recordingV2.id))
    .leftJoin(spotifyTrack, eq(recordingTrackV2.spotifyTrackId, spotifyTrack.spotifyId))
    .innerJoin(work, eq(recordingV2.workId, work.id))
    .innerJoin(composer, eq(work.composerId, composer.id))
    .where(eq(recordingV2.workId, workId));

  const trackIds = rows
    .map((r) => r.trackId)
    .filter((trackId): trackId is string => trackId !== null);
  const [performers, mbCredits] = await Promise.all([
    performersFor(trackIds),
    musicbrainzCreditsFor(trackIds),
  ]);
  const liked = new Set(likedTrackIds);

  const byRecording = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = byRecording.get(row.recordingId) ?? [];
    list.push(row);
    byRecording.set(row.recordingId, list);
  }

  const out: CatalogRecording[] = [];
  for (const [recordingId, list] of byRecording) {
    const head = list[0];
    const tracks = new Map<string, (typeof rows)[number]>();
    for (const row of list) {
      if (row.trackId !== null && !tracks.has(row.trackId)) tracks.set(row.trackId, row);
    }
    const ordered = Array.from(tracks.values()).sort(
      (a, b) =>
        (a.discNumber ?? Number.MAX_SAFE_INTEGER) - (b.discNumber ?? Number.MAX_SAFE_INTEGER) ||
        (a.trackNumber ?? Number.MAX_SAFE_INTEGER) - (b.trackNumber ?? Number.MAX_SAFE_INTEGER),
    );
    const durationMs = ordered.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
    const orderedTrackIds = ordered.flatMap((track) =>
      track.trackId === null ? [] : [track.trackId],
    );
    const credited = creditsFor(orderedTrackIds, performers, head.composerArtistId, mbCredits);
    out.push({
      id: recordingId,
      album: head.album,
      albumId: head.albumId,
      cover: coverOf(head.images),
      year: head.albumYear,
      performer: credited.performer,
      ensemble: credited.ensemble,
      duration: ordered.length > 0 ? formatDuration(durationMs) : null,
      popularity: head.popularity,
      tint: tintFor(head.albumId).tint,
      liked: orderedTrackIds.filter((trackId) => liked.has(trackId)).length,
      firstTrackUri: ordered[0] ? `spotify:track:${ordered[0].trackId}` : null,
      unmatched: Number(head.mappedTrackCount) === 0,
    });
  }

  return out.sort(
    (a, b) => (b.popularity ?? -1) - (a.popularity ?? -1) || (a.year ?? 0) - (b.year ?? 0),
  );
}

/** The work heading above column three. */
export async function getCatalogWorkHeader(workId: number) {
  const [row] = await db
    .select({
      id: work.id,
      title: work.title,
      nickname: work.nickname,
      yearComposed: work.yearComposed,
      form: work.form,
      catalogSystem: workCatalogV2.system,
      catalogNumber: workCatalogV2.number,
      composerName: composer.name,
      movementCount: sql<number>`(select count(*) from ${workPartV2} where ${workPartV2.workId} = ${work.id})`,
    })
    .from(work)
    .innerJoin(composer, eq(work.composerId, composer.id))
    .leftJoin(
      workCatalogV2,
      and(eq(workCatalogV2.workId, work.id), eq(workCatalogV2.isPrimary, true)),
    )
    .where(eq(work.id, workId))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    nickname: row.nickname,
    catalog: catalogLabel(row.catalogSystem, row.catalogNumber),
    year: row.yearComposed,
    genre: titleCase(row.form),
    composerName: row.composerName,
    movementCount: Number(row.movementCount),
  };
}

/* =========================================================
   SEARCH
   ========================================================= */

export interface WorkSearchHit {
  workId: number;
  title: string;
  nickname: string | null;
  composerId: number;
  composerName: string;
  /** The reference the search matched on, which may not be the primary one. */
  matchedOn: string | null;
  /** Every reference the work carries, so the reader can see what it is called. */
  references: string[];
  recordingCount: number;
}

/**
 * Find works by catalogue reference or by title.
 *
 * A catalogue reference matches *any* of a work's references, not only the
 * one shown on its card. That is the whole point of importing alternates from
 * MusicBrainz: a Scarlatti sonata carries Kk. 9, L 413 and K 9, and a reader
 * who knows the Longo number should find it even though the card says Kk.
 *
 * Text search is deliberately plain — title, nickname, composer — because a
 * cleverer ranking would need tuning against a corpus we do not have, and a
 * list that is merely unsorted is better than one that is confidently wrong.
 */
export async function searchWorks(rawQuery: string, limit = 40): Promise<WorkSearchHit[]> {
  const parsed = parseCatalogueQuery(rawQuery);
  if (parsed.kind === 'text' && parsed.text.length < 2) return [];

  const matching = alias(workCatalogV2, 'matching_catalog');

  const condition =
    parsed.kind === 'reference'
      ? and(
          eq(matching.normalizedSystem, parsed.system),
          eq(matching.normalizedNumber, parsed.number),
        )
      : parsed.kind === 'number'
        ? eq(matching.normalizedNumber, parsed.number)
        : or(
            sql`lower(${work.title}) like ${'%' + parsed.text + '%'}`,
            sql`lower(coalesce(${work.nickname}, '')) like ${'%' + parsed.text + '%'}`,
            sql`lower(${composer.name}) like ${'%' + parsed.text + '%'}`,
          );

  const rows = await db
    .selectDistinct({
      workId: work.id,
      title: work.title,
      nickname: work.nickname,
      composerId: composer.id,
      composerName: composer.name,
      matchedOn:
        parsed.kind === 'text'
          ? sql<string | null>`null`
          : sql<string | null>`${matching.system} || ' ' || ${matching.number}`,
      recordingCount: sql<number>`(select count(*) from ${recordingV2} where ${recordingV2.workId} = ${work.id})`,
    })
    .from(work)
    .innerJoin(composer, eq(composer.id, work.composerId))
    .leftJoin(matching, eq(matching.workId, work.id))
    .where(condition)
    .limit(limit);

  if (rows.length === 0) return [];

  const references = new Map<number, string[]>();
  const refRows = await db
    .select({
      workId: workCatalogV2.workId,
      system: workCatalogV2.system,
      number: workCatalogV2.number,
    })
    .from(workCatalogV2)
    .where(
      inArray(
        workCatalogV2.workId,
        rows.map((row) => row.workId),
      ),
    );
  for (const row of refRows) {
    references.set(row.workId, [
      ...(references.get(row.workId) ?? []),
      `${row.system} ${row.number}`,
    ]);
  }

  return rows.map((row) => ({ ...row, references: references.get(row.workId) ?? [] }));
}

/* =========================================================
   WORK HIERARCHY
   ========================================================= */

export interface WorkSibling {
  /** Our work, when we hold one for this part of the collection. */
  workId: number | null;
  title: string;
  /** Its position among the parent's parts, as MusicBrainz orders them. */
  ordering: number | null;
  isCurrent: boolean;
}

export interface WorkParent {
  title: string;
  /** Every part MusicBrainz lists, including ones we do not have. */
  siblings: WorkSibling[];
  /** How many of those parts we hold a work for. */
  held: number;
}

/**
 * The collection a work belongs to, and what else is in it.
 *
 * "Prelude and Fugue No. 1 in C major" is one of forty-eight in The
 * Well-Tempered Clavier, and until now nothing said so: our own model is
 * flat, and the parent relationship exists only in MusicBrainz's tree.
 *
 * Siblings MusicBrainz lists that we hold no work for are returned too, with
 * a null id. A collection showing twenty-three of its forty-eight parts
 * should say so rather than looking like a complete list of twenty-three —
 * the gap is the point.
 */
export async function getWorkParent(workId: number): Promise<WorkParent | null> {
  const [self] = await db
    .select({ mbid: work.musicbrainzId })
    .from(work)
    .where(eq(work.id, workId))
    .limit(1);
  if (!self?.mbid) return null;

  const [node] = await db
    .select({ parentMbid: mbWork.parentMbid })
    .from(mbWork)
    .where(eq(mbWork.mbid, self.mbid))
    .limit(1);
  if (!node?.parentMbid) return null;

  const [parent] = await db
    .select({ title: mbWork.title })
    .from(mbWork)
    .where(eq(mbWork.mbid, node.parentMbid))
    .limit(1);
  if (!parent) return null;

  const children = alias(mbWork, 'child');
  const rows = await db
    .select({
      mbid: children.mbid,
      title: children.title,
      ordering: children.orderingKey,
      workId: work.id,
    })
    .from(children)
    .leftJoin(work, eq(work.musicbrainzId, children.mbid))
    .where(eq(children.parentMbid, node.parentMbid))
    .orderBy(asc(children.orderingKey));

  const siblings: WorkSibling[] = rows.map((row) => ({
    workId: row.workId ?? null,
    title: stripCollectionPrefix(row.title, parent.title),
    ordering: row.ordering,
    isCurrent: row.mbid === self.mbid,
  }));

  return {
    title: parent.title,
    siblings,
    held: siblings.filter((sibling) => sibling.workId !== null).length,
  };
}

/**
 * MusicBrainz titles a part with its collection in front. Repeating that on
 * every row of a list headed by the collection is noise.
 */
function stripCollectionPrefix(title: string, parentTitle: string): string {
  const prefix = `${parentTitle}:`;
  if (!title.startsWith(prefix)) return title;
  return title.slice(prefix.length).trim() || title;
}
