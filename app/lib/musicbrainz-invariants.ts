/**
 * What must be true of the MusicBrainz cache.
 *
 * Defined once and run from three places, because a script somebody remembers
 * to type was right for a single-user catalogue and is wrong for a service
 * ingesting continuously: a violation can accumulate for days before anyone
 * looks. The cheap ones run in the worker after each album, so a violation
 * fails that album instead of landing quietly; the whole set runs on a
 * schedule into a table that admin shows; and the same definitions back the
 * CLI for local work and CI.
 *
 * The distinction that matters here is between a broken cache and a wrong
 * upstream. A recording referenced by a tracklist that we never stored is our
 * bug. An ISRC claimed by two recordings is MusicBrainz's, and it is reported
 * rather than failed — it is a contribution, not a defect to fix locally.
 */
import { sql } from 'drizzle-orm';
import { db } from './db';
import { mbInvariantResult } from './db/schema';

/**
 * - `hard`: our cache is inconsistent with itself. Our bug, and it fails.
 * - `upstream`: MusicBrainz contradicts itself. Their bug, and we report it
 *   so it can be contributed back rather than repaired locally.
 * - `review`: the evidence points two ways and neither side is obviously
 *   wrong. Nothing to fix automatically; somebody has to look.
 */
export type InvariantSeverity = 'hard' | 'upstream' | 'review';

export type Invariant = {
  name: string;
  severity: InvariantSeverity;
  /** What is wrong, and why it matters, for whoever reads the report. */
  describes: string;
  /** Cheap enough to run after every album. */
  cheap: boolean;
  query: ReturnType<typeof sql>;
};

export const MUSICBRAINZ_INVARIANTS: Invariant[] = [
  {
    name: 'anchored-recording-is-cached',
    severity: 'hard',
    describes: 'A track is anchored to a recording the cache does not hold.',
    cheap: true,
    query: sql`
      select tr.spotify_track_id as id, tr.recording_mbid as detail
      from track_recording tr
      where not exists (select 1 from mb_recording r where r.mbid = tr.recording_mbid)
    `,
  },
  {
    name: 'tracklist-recording-is-cached',
    severity: 'hard',
    describes: 'A release tracklist names a recording that was never stored.',
    cheap: true,
    query: sql`
      select rt.release_mbid as id, rt.recording_mbid as detail
      from mb_release_track rt
      where not exists (select 1 from mb_recording r where r.mbid = rt.recording_mbid)
    `,
  },
  {
    name: 'work-parent-is-cached',
    severity: 'hard',
    describes: 'A work points at a parent the cache does not hold, so the tree has a hole.',
    cheap: false,
    query: sql`
      select w.mbid as id, w.parent_mbid as detail
      from mb_work w
      where w.parent_mbid is not null
        and not exists (select 1 from mb_work p where p.mbid = w.parent_mbid)
    `,
  },
  {
    name: 'work-composer-is-cached',
    severity: 'hard',
    describes: 'A work names a composer with no artist row.',
    cheap: false,
    query: sql`
      select w.mbid as id, w.composer_mbid as detail
      from mb_work w
      where w.composer_mbid is not null
        and not exists (select 1 from mb_artist a where a.mbid = w.composer_mbid)
    `,
  },
  {
    name: 'work-is-not-its-own-parent',
    severity: 'hard',
    describes: 'A work is its own parent, which would make the tree walk loop.',
    cheap: false,
    query: sql`select mbid as id, parent_mbid as detail from mb_work where parent_mbid = mbid`,
  },
  {
    name: 'work-tree-has-no-cycle',
    severity: 'hard',
    describes: 'A chain of parents returns to where it started, so the tree is not a tree.',
    cheap: false,
    query: sql`
      with recursive climb(root, node, depth) as (
        select mbid, parent_mbid, 1 from mb_work where parent_mbid is not null
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
    query: sql`
      select i.isrc as id, i.recording_mbid as detail
      from mb_recording_isrc i
      where not exists (select 1 from mb_recording r where r.mbid = i.recording_mbid)
    `,
  },
  {
    name: 'submission-has-a-target',
    severity: 'hard',
    describes: 'A submission names a MusicBrainz entity that is not in the cache.',
    cheap: false,
    query: sql`
      select cast(s.id as text) as id, s.target_mbid as detail
      from mb_submission s
      where s.kind = 'isrc'
        and s.target_mbid is not null
        and not exists (select 1 from mb_recording r where r.mbid = s.target_mbid)
    `,
  },
  {
    name: 'isrc-disagrees-with-position',
    severity: 'review',
    describes:
      "A track's ISRC names one recording and its place on the release names another. Either the release we matched is the wrong edition, or MusicBrainz holds the same performance twice. Anchoring keeps the position it already had rather than guessing between them.",
    cheap: false,
    query: sql`
      select tr.spotify_track_id as id,
             tr.recording_mbid || ' vs ' || i.recording_mbid as detail
        from track_recording tr
        join mb_recording_isrc i on i.isrc = tr.isrc
       where tr.matched_by = 'release_position'
         and i.recording_mbid <> tr.recording_mbid
    `,
  },
  {
    name: 'one-isrc-one-recording',
    severity: 'upstream',
    describes:
      'MusicBrainz maps one ISRC to several recordings. An ISRC identifies a recording, so one of them is wrong — a contribution, not a local defect.',
    cheap: false,
    query: sql`
      select isrc as id, group_concat(recording_mbid, ' ') as detail
      from mb_recording_isrc group by isrc having count(*) > 1
    `,
  },
];

export type InvariantResult = {
  name: string;
  severity: InvariantSeverity;
  describes: string;
  violations: number;
  samples: { id: string; detail: string | null }[];
};

export async function runMusicBrainzInvariants(
  options: { cheapOnly?: boolean; sampleSize?: number } = {},
): Promise<InvariantResult[]> {
  const sampleSize = options.sampleSize ?? 5;
  const checks = options.cheapOnly
    ? MUSICBRAINZ_INVARIANTS.filter((check) => check.cheap)
    : MUSICBRAINZ_INVARIANTS;

  const results: InvariantResult[] = [];
  for (const check of checks) {
    const rows = await db.all<{ id: string; detail: string | null }>(check.query);
    results.push({
      name: check.name,
      severity: check.severity,
      describes: check.describes,
      violations: rows.length,
      samples: rows.slice(0, sampleSize),
    });
  }
  return results;
}

/** The hard violations only, for a caller that has to decide whether to proceed. */
export function hardViolations(results: InvariantResult[]): InvariantResult[] {
  return results.filter((result) => result.severity === 'hard' && result.violations > 0);
}

/** Store the latest result of each check, so admin can show it as a page. */
export async function recordInvariantResults(results: InvariantResult[]) {
  for (const result of results) {
    const row = {
      name: result.name,
      severity: result.severity,
      violations: result.violations,
      samples: result.samples,
      checkedAt: new Date(),
    };
    await db
      .insert(mbInvariantResult)
      .values(row)
      .onConflictDoUpdate({ target: mbInvariantResult.name, set: row });
  }
}

/** The stored results, for the admin page. */
export async function latestInvariantResults(): Promise<InvariantResult[]> {
  const rows = await db.select().from(mbInvariantResult);
  const described = new Map(MUSICBRAINZ_INVARIANTS.map((check) => [check.name, check.describes]));
  return rows.map((row) => ({
    name: row.name,
    severity: row.severity,
    describes: described.get(row.name) ?? '',
    violations: row.violations,
    samples: row.samples ?? [],
  }));
}
