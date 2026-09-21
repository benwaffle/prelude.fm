/**
 * Name the movements MusicBrainz knows and we do not.
 *
 * The earlier promotion worked from `musicbrainz_fact`, which was filled by
 * the old per-work backfill. The cache reaches further: anchoring ties a
 * track to a recording, and the recording says which work it performs, so a
 * part with no name can be named even where no fact was ever recorded for
 * it.
 *
 * Only fills blanks. A part that already has a title is left alone — that
 * decision belongs to the adoption pass, which has its own rules about when
 * MusicBrainz may replace one.
 *
 * Costs no requests. Dry run by default; `--apply` writes.
 *
 *   pnpm metadata:name-parts [--apply]
 */
import { loadEnvConfig } from '@next/env';

async function main() {
  const apply = process.argv.includes('--apply');
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is required');

  const [{ db }, schema, promotion, drizzle] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('@/lib/musicbrainz-promotion'),
    import('drizzle-orm'),
  ]);
  const { workPartV2 } = schema;
  const { movementTitleFromMusicBrainz } = promotion;
  const { eq, sql } = drizzle;

  const rows = await db.all<{
    partId: number;
    label: string | null;
    mbTitle: string;
    parentTitle: string | null;
  }>(sql`
    select distinct wp.id as partId, wp.label, mw.title as mbTitle, p.title as parentTitle
      from work_part_v2 wp
      join track_work_part_v2 twp on twp.work_part_id = wp.id
      join track_recording tr on tr.spotify_track_id = twp.spotify_track_id
      join mb_recording_work rw on rw.recording_mbid = tr.recording_mbid
      join mb_work mw on mw.mbid = rw.work_mbid
      left join mb_work p on p.mbid = mw.parent_mbid
     where wp.title is null or trim(wp.title) = ''
  `);

  // A part reached through two different MusicBrainz works has no single
  // answer, and picking one would be a guess.
  const proposals = new Map<number, string | null>();
  const contested = new Set<number>();
  for (const row of rows) {
    const title = movementTitleFromMusicBrainz(row.mbTitle, row.label);
    if (!title) continue;
    const existing = proposals.get(row.partId);
    if (existing !== undefined && existing !== title) contested.add(row.partId);
    proposals.set(row.partId, title);
  }

  let named = 0;
  const examples: string[] = [];
  for (const [partId, title] of proposals) {
    if (!title || contested.has(partId)) continue;
    named++;
    if (examples.length < 8) examples.push(`part ${partId}: "${title}"`);
    if (apply) {
      await db.update(workPartV2).set({ title }).where(eq(workPartV2.id, partId));
    }
  }

  console.log(apply ? 'Applied.' : 'Dry run. Pass --apply to write.');
  console.log(`
  unnamed parts MusicBrainz reaches  ${proposals.size}
    named                            ${named}
    two works disagree               ${contested.size}
    MusicBrainz title unusable       ${rows.length - proposals.size}`);
  if (examples.length) console.log('\n  ' + examples.join('\n  '));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
