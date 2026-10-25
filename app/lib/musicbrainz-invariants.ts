// A broken cache is our bug and fails; a wrong upstream (an ISRC on two recordings) is reported as
// a contribution.
import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from './db';
import { jsonList } from './db/chunked';
import { mbInvariantResult } from './db/schema';
import {
  invariantHealth,
  SWEEP_PASS_DAYS,
  type InvariantHealth,
  type InvariantSeverity,
} from './musicbrainz-invariant-health';

export {
  INVARIANT_STALE_AFTER_HOURS,
  SWEEP_PASS_DAYS,
  type InvariantHealth,
  type InvariantSeverity,
} from './musicbrainz-invariant-health';

// Which rows of a check's `table` to read: all of them, or one slice of its rowids. The daily sweep
// reads a slice of every check each day; `pnpm metadata:validate` and `mb:ingest check` read it all.
export type Within = { full: boolean; rowid: (column: SQL) => SQL };

export const EVERYTHING: Within = { full: true, rowid: () => sql`1 = 1` };

export function rowidsBetween(after: number, upTo: number): Within {
  return { full: false, rowid: (column) => sql`${column} > ${after} and ${column} <= ${upTo}` };
}

export type Invariant = {
  name: string;
  severity: InvariantSeverity;
  describes: string;
  cheap: boolean;
  /** The table the check walks; the sweep slices it by rowid. */
  table: string;
  query: (within: Within) => SQL;
  // The same check over what a pass just wrote for these albums: the whole table is millions of
  // rows once the dump is in, and a pass runs the cheap checks after every album.
  scoped?: (albums: SQL) => SQL;
};

// The rows a pass writes for its albums: their tracks' anchors, and their releases' tracklists.
const tracksOf = (albums: SQL) =>
  sql`select spotify_id from spotify_track where spotify_album_id in (${albums})`;
const releasesOf = (albums: SQL) =>
  sql`select mb_release_id from spotify_album where spotify_id in (${albums}) and mb_release_id is not null`;

export const MUSICBRAINZ_INVARIANTS: Invariant[] = [
  {
    name: 'anchored-recording-is-cached',
    severity: 'hard',
    describes: 'A track is anchored to a recording the cache does not hold.',
    cheap: true,
    table: 'track_recording',
    query: (within) => sql`
      select tr.spotify_track_id as id, tr.recording_mbid as detail
      from track_recording tr
      where ${within.rowid(sql`tr.rowid`)}
        and not exists (select 1 from mb_recording r where r.mbid = tr.recording_mbid)
    `,
    scoped: (albums) => sql`
      select tr.spotify_track_id as id, tr.recording_mbid as detail
      from track_recording tr
      where tr.spotify_track_id in (${tracksOf(albums)})
        and not exists (select 1 from mb_recording r where r.mbid = tr.recording_mbid)
    `,
  },
  {
    name: 'tracklist-recording-is-cached',
    severity: 'hard',
    describes: 'A release tracklist names a recording that was never stored.',
    cheap: true,
    table: 'mb_release_track',
    query: (within) => sql`
      select rt.release_mbid as id, rt.recording_mbid as detail
      from mb_release_track rt
      where ${within.rowid(sql`rt.rowid`)}
        and not exists (select 1 from mb_recording r where r.mbid = rt.recording_mbid)
    `,
    scoped: (albums) => sql`
      select rt.release_mbid as id, rt.recording_mbid as detail
      from mb_release_track rt
      where rt.release_mbid in (${releasesOf(albums)})
        and not exists (select 1 from mb_recording r where r.mbid = rt.recording_mbid)
    `,
  },
  {
    name: 'work-parent-is-cached',
    severity: 'hard',
    describes: 'A work points at a parent the cache does not hold, so the tree has a hole.',
    cheap: false,
    table: 'mb_work',
    query: (within) => sql`
      select w.mbid as id, w.parent_mbid as detail
      from mb_work w
      where ${within.rowid(sql`w.rowid`)}
        and w.parent_mbid is not null
        and not exists (select 1 from mb_work p where p.mbid = w.parent_mbid)
    `,
  },
  {
    name: 'work-composer-is-cached',
    severity: 'hard',
    describes: 'A work names a composer with no artist row.',
    cheap: false,
    table: 'mb_work',
    query: (within) => sql`
      select w.mbid as id, w.composer_mbid as detail
      from mb_work w
      where ${within.rowid(sql`w.rowid`)}
        and w.composer_mbid is not null
        and not exists (select 1 from mb_artist a where a.mbid = w.composer_mbid)
    `,
  },
  {
    name: 'work-is-not-its-own-parent',
    severity: 'hard',
    describes: 'A work is its own parent, which would make the tree walk loop.',
    cheap: false,
    table: 'mb_work',
    query: (within) =>
      sql`select mbid as id, parent_mbid as detail from mb_work where ${within.rowid(sql`rowid`)} and parent_mbid = mbid`,
  },
  {
    name: 'work-tree-has-no-cycle',
    severity: 'hard',
    describes: 'A chain of parents returns to where it started, so the tree is not a tree.',
    cheap: false,
    table: 'mb_work',
    // Every member of a cycle finds it, so a slice finds it from the members it holds.
    query: (within) => sql`
      with recursive climb(root, node, depth) as (
        select mbid, parent_mbid, 1 from mb_work
        where ${within.rowid(sql`rowid`)} and parent_mbid is not null
        union all
        select c.root, w.parent_mbid, c.depth + 1
        from climb c join mb_work w on w.mbid = c.node
        where w.parent_mbid is not null and c.depth < 12
      )
      select distinct root as id, 'returns to itself' as detail from climb where node = root
    `,
  },
  {
    name: 'isrc-recording-is-cached',
    severity: 'hard',
    describes: 'An ISRC points at a recording the cache does not hold.',
    cheap: true,
    table: 'mb_recording_isrc',
    query: (within) => sql`
      select i.isrc as id, i.recording_mbid as detail
      from mb_recording_isrc i
      where ${within.rowid(sql`i.rowid`)}
        and not exists (select 1 from mb_recording r where r.mbid = i.recording_mbid)
    `,
    scoped: (albums) => sql`
      select i.isrc as id, i.recording_mbid as detail
      from mb_recording_isrc i
      where i.recording_mbid in (
          select recording_mbid from mb_release_track where release_mbid in (${releasesOf(albums)})
          union
          select recording_mbid from track_recording where spotify_track_id in (${tracksOf(albums)}))
        and not exists (select 1 from mb_recording r where r.mbid = i.recording_mbid)
    `,
  },
  {
    name: 'submission-has-a-target',
    severity: 'hard',
    describes: 'A submission names a MusicBrainz entity that is not in the cache.',
    cheap: false,
    table: 'mb_submission',
    query: (within) => sql`
      select cast(s.id as text) as id, s.target_mbid as detail
      from mb_submission s
      where ${within.rowid(sql`s.rowid`)}
        and s.kind = 'isrc'
        and s.target_mbid is not null
        and not exists (select 1 from mb_recording r where r.mbid = s.target_mbid)
    `,
  },
  {
    // A pass stores every track Spotify lists before deciding anything; older passes skipped
    // non-classical tracks.
    name: 'finished-track-is-stored',
    severity: 'hard',
    describes:
      'The match queue finished with a track that was never written down from Spotify, so its album reads shorter than it is.',
    cheap: false,
    table: 'match_queue',
    query: (within) => sql`
      select q.spotify_id as id, q.spotify_album_id as detail
      from match_queue q
      where ${within.rowid(sql`q.rowid`)}
        and q.status in ('matched', 'not_classical', 'unresolved')
        and not exists (select 1 from spotify_track t where t.spotify_id = q.spotify_id)
    `,
  },
  {
    // Queued rather than stored, so a track queued but not yet processed doesn't count as missing.
    name: 'album-is-fully-queued',
    severity: 'hard',
    describes:
      'Spotify lists more tracks on an album than we ever queued, so the album reads shorter than it is.',
    cheap: false,
    table: 'spotify_album',
    // Each album's queue is counted once, not once for the test and again for the detail.
    query: (within) => sql`
      select id, queued || ' of ' || total as detail
      from (
        select a.spotify_id as id, a.spotify_track_total as total,
               (select count(*) from match_queue q where q.spotify_album_id = a.spotify_id) as queued
        from spotify_album a
        where ${within.rowid(sql`a.rowid`)} and a.spotify_track_total is not null
      )
      where total > queued
    `,
  },
  {
    name: 'isrc-disagrees-with-position',
    severity: 'review',
    describes:
      "A track's ISRC names one recording and its place on the release names another. Either the release we matched is the wrong edition, or MusicBrainz holds the same performance twice. Anchoring keeps the position it already had rather than guessing between them.",
    cheap: false,
    table: 'track_recording',
    query: (within) => sql`
      select tr.spotify_track_id as id,
             tr.recording_mbid || ' vs ' || i.recording_mbid as detail
        from track_recording tr
        join mb_recording_isrc i on i.isrc = tr.isrc
       where ${within.rowid(sql`tr.rowid`)}
         and tr.matched_by = 'release_position'
         and i.recording_mbid <> tr.recording_mbid
    `,
  },
  {
    name: 'one-isrc-one-recording',
    severity: 'upstream',
    describes:
      'MusicBrainz maps one ISRC to several recordings. An ISRC identifies a recording, so one of them is wrong — a contribution, not a local defect.',
    cheap: false,
    table: 'mb_recording_isrc',
    // A slice reports the ISRCs whose first row it holds, so each is counted once a pass.
    query: (within) =>
      within.full
        ? sql`
            select isrc as id, group_concat(recording_mbid, ' ') as detail
            from mb_recording_isrc group by isrc having count(*) > 1
          `
        : sql`
            select i.isrc as id, group_concat(i.recording_mbid, ' ') as detail
            from mb_recording_isrc i
            where i.isrc in (select s.isrc from mb_recording_isrc s where ${within.rowid(sql`s.rowid`)})
            group by i.isrc having count(*) > 1 and ${within.rowid(sql`min(i.rowid)`)}
          `,
  },
];

export type InvariantResult = {
  name: string;
  severity: InvariantSeverity;
  describes: string;
  violations: number;
  samples: { id: string; detail: string | null }[];
  checkedAt?: Date | null;
  /** The sweep's pass in progress, if any. */
  sweep?: InvariantSweep | null;
  sweepViolations?: number | null;
};

export type InvariantSweep = {
  /** Rowid read up to, of `end` (the table's last rowid when the pass began). */
  cursor: number;
  end: number;
  violations: number;
  startedAt: Date | null;
};

export function musicBrainzInvariantHealth(
  results: InvariantResult[],
  now: Date = new Date(),
): InvariantHealth {
  return invariantHealth(MUSICBRAINZ_INVARIANTS, results, now);
}

// `albums`: only the cheap checks, over what a pass wrote for these albums. Its results say
// nothing about the rest of the cache, so they are not a sweep's: record them only when they
// found something.
export async function runMusicBrainzInvariants(
  options: { cheapOnly?: boolean; sampleSize?: number; albums?: string[] } = {},
): Promise<InvariantResult[]> {
  const sampleSize = options.sampleSize ?? 5;
  const albums = options.albums;
  const checks =
    options.cheapOnly || albums
      ? MUSICBRAINZ_INVARIANTS.filter((check) => check.cheap)
      : MUSICBRAINZ_INVARIANTS;
  if (albums?.length === 0) return [];

  // Count each check, then read a sample only of one that failed: on a clean cache a sample query
  // reads the whole table again to find nothing.
  return Promise.all(
    checks.map(async (check): Promise<InvariantResult> => {
      const query =
        albums && check.scoped ? check.scoped(jsonList(albums)) : check.query(EVERYTHING);
      const counted = await db.get<{ n: number }>(sql`select count(*) as n from (${query})`);
      const samples =
        (counted?.n ?? 0) > 0
          ? await db.all<{ id: string; detail: string | null }>(
              sql`select * from (${query}) limit ${sampleSize}`,
            )
          : [];
      return {
        name: check.name,
        severity: check.severity,
        describes: check.describes,
        violations: counted?.n ?? 0,
        samples,
      };
    }),
  );
}

export function hardViolations(results: InvariantResult[]): InvariantResult[] {
  return results.filter(
    (result) =>
      result.severity === 'hard' && (result.violations > 0 || (result.sweepViolations ?? 0) > 0),
  );
}

export async function recordInvariantResults(results: InvariantResult[]) {
  if (results.length === 0) return;
  const checkedAt = new Date();
  await db
    .insert(mbInvariantResult)
    .values(
      results.map((result) => ({
        name: result.name,
        severity: result.severity,
        violations: result.violations,
        samples: result.samples,
        checkedAt,
      })),
    )
    .onConflictDoUpdate({
      target: mbInvariantResult.name,
      set: {
        severity: sql`excluded.severity`,
        violations: sql`excluded.violations`,
        samples: sql`excluded.samples`,
        checkedAt: sql`excluded.checked_at`,
      },
    });
}

export async function latestInvariantResults(): Promise<InvariantResult[]> {
  const rows = await db.select().from(mbInvariantResult);
  const described = new Map(MUSICBRAINZ_INVARIANTS.map((check) => [check.name, check.describes]));
  return rows.map((row) => ({
    name: row.name,
    severity: row.severity,
    describes: described.get(row.name) ?? '',
    violations: row.violations,
    samples: row.samples ?? [],
    checkedAt: row.checkedAt.getTime() === NEVER.getTime() ? null : row.checkedAt,
    sweep: sweepOf(row),
    sweepViolations: row.sweepViolations,
  }));
}

function sweepOf(row: typeof mbInvariantResult.$inferSelect): InvariantSweep | null {
  if (row.sweepCursor === null || row.sweepEnd === null) return null;
  return {
    cursor: row.sweepCursor,
    end: row.sweepEnd,
    violations: row.sweepViolations ?? 0,
    startedAt: row.sweepStartedAt,
  };
}

// The daily cron's sweep. Reading every check over the whole cache each day would be ~50M rows
// once the dump is in, so each run reads the next slice of each check's table: 1/SWEEP_PASS_DAYS
// of it, or `minRows` rowids when that is more (a small table is read whole every day). A pass
// stops at the last rowid the table had when it began; rows written later are read by the next
// pass, and what a match pass writes is checked straight away by the scoped checks. A finished
// pass records its count as the check's result; until then, what it has found so far is kept
// beside the last result, and a hard violation fails health at once.
export async function sweepMusicBrainzInvariants(
  options: { passDays?: number; minRows?: number; sampleSize?: number; now?: Date } = {},
): Promise<InvariantResult[]> {
  const passDays = options.passDays ?? SWEEP_PASS_DAYS;
  const minRows = options.minRows ?? 50_000;
  const sampleSize = options.sampleSize ?? 5;
  const now = options.now ?? new Date();
  const held = new Map((await db.select().from(mbInvariantResult)).map((row) => [row.name, row]));

  const results: InvariantResult[] = [];
  for (const check of MUSICBRAINZ_INVARIANTS) {
    const row = held.get(check.name);
    const fresh = !row || row.sweepCursor === null || row.sweepEnd === null;
    const end = fresh
      ? ((
          await db.get<{ end: number | null }>(
            sql`select max(rowid) as end from ${sql.raw(check.table)}`,
          )
        )?.end ?? 0)
      : row.sweepEnd!;
    const after = fresh ? 0 : row.sweepCursor!;
    const startedAt = fresh ? now : (row.sweepStartedAt ?? now);
    const upTo = Math.min(end, after + Math.max(minRows, Math.ceil(end / passDays)));

    const query = check.query(rowidsBetween(after, upTo));
    const counted = await db.get<{ n: number }>(sql`select count(*) as n from (${query})`);
    const found = counted?.n ?? 0;
    const soFar = fresh ? [] : (row.sweepSamples ?? []);
    const samples =
      found > 0 && soFar.length < sampleSize
        ? [
            ...soFar,
            ...(await db.all<{ id: string; detail: string | null }>(
              sql`select * from (${query}) limit ${sampleSize - soFar.length}`,
            )),
          ]
        : soFar;
    const violations = (fresh ? 0 : (row.sweepViolations ?? 0)) + found;

    if (upTo >= end) {
      // A scoped check that found something during this pass may have been passed over already.
      const keptScoped = row && !fresh && row.checkedAt > startedAt && row.violations > violations;
      const result = {
        name: check.name,
        severity: check.severity,
        violations: keptScoped ? row.violations : violations,
        samples: keptScoped ? (row.samples ?? []) : samples,
        checkedAt: now,
      };
      await db
        .insert(mbInvariantResult)
        .values({ ...result, ...NO_SWEEP })
        .onConflictDoUpdate({ target: mbInvariantResult.name, set: { ...result, ...NO_SWEEP } });
      results.push({ ...result, describes: check.describes, sweep: null });
    } else {
      const sweep = {
        sweepCursor: upTo,
        sweepEnd: end,
        sweepViolations: violations,
        sweepSamples: samples,
        sweepStartedAt: startedAt,
      };
      if (row) {
        await db.update(mbInvariantResult).set(sweep).where(eq(mbInvariantResult.name, check.name));
      } else {
        // Never checked: there is no result until the pass ends, so the row reads as never run.
        await db.insert(mbInvariantResult).values({
          name: check.name,
          severity: check.severity,
          violations: 0,
          samples: [],
          checkedAt: NEVER,
          ...sweep,
        });
      }
      results.push({
        name: check.name,
        severity: check.severity,
        describes: check.describes,
        violations: row?.violations ?? 0,
        samples: row?.samples ?? [],
        checkedAt: row && row.checkedAt.getTime() !== NEVER.getTime() ? row.checkedAt : null,
        sweep: { cursor: upTo, end, violations, startedAt },
        sweepViolations: violations,
      });
    }
  }
  return results;
}

/** `checked_at` of a check whose first pass is still under way. */
const NEVER = new Date(0);

const NO_SWEEP = {
  sweepCursor: null,
  sweepEnd: null,
  sweepViolations: null,
  sweepSamples: null,
  sweepStartedAt: null,
};
