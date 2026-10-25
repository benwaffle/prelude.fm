// A broken cache is our bug and fails; a wrong upstream (an ISRC on two recordings) is reported as
// a contribution.
import { sql, type SQL } from 'drizzle-orm';
import { db } from './db';
import { jsonList } from './db/chunked';
import { mbInvariantResult } from './db/schema';
import {
  invariantHealth,
  type InvariantHealth,
  type InvariantSeverity,
} from './musicbrainz-invariant-health';

export {
  INVARIANT_STALE_AFTER_HOURS,
  type InvariantHealth,
  type InvariantSeverity,
} from './musicbrainz-invariant-health';

export type Invariant = {
  name: string;
  severity: InvariantSeverity;
  describes: string;
  cheap: boolean;
  query: ReturnType<typeof sql>;
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
    query: sql`
      select tr.spotify_track_id as id, tr.recording_mbid as detail
      from track_recording tr
      where not exists (select 1 from mb_recording r where r.mbid = tr.recording_mbid)
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
    query: sql`
      select rt.release_mbid as id, rt.recording_mbid as detail
      from mb_release_track rt
      where not exists (select 1 from mb_recording r where r.mbid = rt.recording_mbid)
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
    query: sql`
      select cast(s.id as text) as id, s.target_mbid as detail
      from mb_submission s
      where s.kind = 'isrc'
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
    query: sql`
      select q.spotify_id as id, q.spotify_album_id as detail
      from match_queue q
      where q.status in ('matched', 'not_classical', 'unresolved')
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
    query: sql`
      select a.spotify_id as id,
             (select count(*) from match_queue q where q.spotify_album_id = a.spotify_id)
               || ' of ' || a.spotify_track_total as detail
      from spotify_album a
      where a.spotify_track_total is not null
        and a.spotify_track_total >
            (select count(*) from match_queue q where q.spotify_album_id = a.spotify_id)
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
  checkedAt?: Date | null;
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
      const query = albums && check.scoped ? check.scoped(jsonList(albums)) : check.query;
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
  return results.filter((result) => result.severity === 'hard' && result.violations > 0);
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
    checkedAt: row.checkedAt,
  }));
}
