/**
 * Link our works to MusicBrainz works, using what anchoring already found.
 *
 * Costs no requests: tracks are anchored to recordings, recordings perform
 * works, and the tree says which level of those works is the piece a reader
 * would name. Rolling that up per work is a query.
 *
 * Dry run by default. `--apply` writes.
 *
 *   pnpm metadata:link-works [--apply]
 */
import { loadEnvConfig } from '@next/env';

async function main() {
  const apply = process.argv.includes('--apply');
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is required');

  const [{ db }, schema, level, linking, drizzle] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('@/lib/musicbrainz-work-level'),
    import('@/lib/musicbrainz-work-linking'),
    import('drizzle-orm'),
  ]);
  const { work } = schema;
  const { workLevelOf } = level;
  const { decideWorkLinks } = linking;
  const { eq, sql } = drizzle;

  // Every (our work, MusicBrainz work) pair the anchoring reaches, with what
  // the tree says about that MusicBrainz work.
  const rows = await db.all<{
    workId: number;
    mbid: string;
    title: string;
    type: string | null;
    parentMbid: string | null;
    parentTitle: string | null;
    hasChildren: number;
    tracks: number;
  }>(sql`
    select w.id as workId, mw.mbid, mw.title, mw.type,
           mw.parent_mbid as parentMbid, p.title as parentTitle,
           exists(select 1 from mb_work c where c.parent_mbid = mw.mbid) as hasChildren,
           count(*) as tracks
      from track_recording tr
      join spotify_track t on t.spotify_id = tr.spotify_track_id
      join track_work_part_v2 twp on twp.spotify_track_id = t.spotify_id
      join work_part_v2 wp on wp.id = twp.work_part_id
      join work w on w.id = wp.work_id
      join mb_recording_work rw on rw.recording_mbid = tr.recording_mbid
      join mb_work mw on mw.mbid = rw.work_mbid
      left join mb_work p on p.mbid = mw.parent_mbid
     group by w.id, mw.mbid
  `);

  // Resolve each reached work to the level a reader would call the piece,
  // then collapse duplicates that resolve to the same level.
  const reached = new Map<string, { workId: number; mbid: string; tracks: number }>();
  let unsettled = 0;
  for (const row of rows) {
    const resolved = workLevelOf({
      mbid: row.mbid,
      title: row.title,
      type: row.type,
      parentMbid: row.parentMbid,
      parentTitle: row.parentTitle,
      hasChildren: Boolean(row.hasChildren),
    });
    if (resolved.needsReview) unsettled++;
    const key = `${row.workId}:${resolved.mbid}`;
    const existing = reached.get(key);
    if (existing) existing.tracks += row.tracks;
    else reached.set(key, { workId: row.workId, mbid: resolved.mbid, tracks: row.tracks });
  }

  const existingLinks = await db
    .select({ id: work.id, mbid: work.musicbrainzId })
    .from(work)
    .where(sql`${work.musicbrainzId} is not null`);
  const claimedBy = new Map(
    existingLinks.flatMap((row) => (row.mbid ? [[row.mbid, row.id] as const] : [])),
  );
  const alreadyLinked = new Set(existingLinks.map((row) => row.id));

  const decisions = decideWorkLinks([...reached.values()], claimedBy);

  const counts = { linked: 0, kept: 0, divided: 0, contested: 0 };
  for (const decision of decisions) {
    if (decision.mbid === null) {
      if (decision.reason === 'divided') counts.divided++;
      if (decision.reason === 'contested') counts.contested++;
      continue;
    }
    if (alreadyLinked.has(decision.workId)) {
      counts.kept++;
      continue;
    }
    counts.linked++;
    if (apply) {
      await db
        .update(work)
        .set({ musicbrainzId: decision.mbid })
        .where(eq(work.id, decision.workId));
    }
  }

  console.log(apply ? 'Applied.' : 'Dry run. Pass --apply to write.');
  console.log(`
  works reached by anchoring   ${new Set([...reached.values()].map((r) => r.workId)).size}
    newly linked               ${counts.linked}
    already linked             ${counts.kept}
    tracks disagree            ${counts.divided}
    MusicBrainz work taken     ${counts.contested}
  levels needing a decision    ${unsettled}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
