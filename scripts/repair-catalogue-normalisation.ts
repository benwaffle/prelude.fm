/**
 * Re-file imported catalogue references so they can be found.
 *
 * The MusicBrainz import stored the series name as the system and the whole
 * printed reference as the number — `Bach-Werke-Verzeichnis` / `BWV 912` —
 * which normalises to `bach-werke-verzeichnis` / `bwv912`. Every
 * parser-derived row sits under `bwv` / `912`, so the two never meet and a
 * reader searching for BWV 912 finds neither the other.
 *
 * `splitCatalogueReference` already separates the sigil from the number for
 * the new cache. This applies the same split to the rows imported before it
 * existed.
 *
 * Where the re-filed row would collide with one we already hold for the same
 * work — the parser having recorded the same reference — the imported row is
 * removed rather than updated: it is the same fact stated twice, and the
 * parser's row is the one the UI already treats as primary.
 *
 * Dry run by default. `--apply` writes.
 *
 *   pnpm metadata:repair-catalogues [--apply]
 */
import { loadEnvConfig } from '@next/env';

async function main() {
  const apply = process.argv.includes('--apply');
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is required');

  const [{ db }, schema, catalogue, drizzle] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('@/lib/musicbrainz-catalogue'),
    import('drizzle-orm'),
  ]);
  const { workCatalogV2 } = schema;
  const { splitCatalogueReference } = catalogue;
  const { and, eq, sql } = drizzle;

  const rows = await db
    .select({
      id: workCatalogV2.id,
      workId: workCatalogV2.workId,
      system: workCatalogV2.system,
      number: workCatalogV2.number,
      normalizedSystem: workCatalogV2.normalizedSystem,
      normalizedNumber: workCatalogV2.normalizedNumber,
    })
    .from(workCatalogV2)
    .where(eq(workCatalogV2.source, 'musicbrainz'));

  let refiled = 0;
  let duplicates = 0;
  let unchanged = 0;
  const examples: string[] = [];

  for (const row of rows) {
    const split = splitCatalogueReference(row.system, row.number);
    if (!split) {
      unchanged++;
      continue;
    }
    if (
      split.normalizedSystem === row.normalizedSystem &&
      split.normalizedNumber === row.normalizedNumber
    ) {
      unchanged++;
      continue;
    }

    const clash = await db
      .select({ id: workCatalogV2.id })
      .from(workCatalogV2)
      .where(
        and(
          eq(workCatalogV2.workId, row.workId),
          eq(workCatalogV2.normalizedSystem, split.normalizedSystem),
          eq(workCatalogV2.normalizedNumber, split.normalizedNumber),
          sql`${workCatalogV2.id} <> ${row.id}`,
        ),
      );

    if (clash.length > 0) {
      duplicates++;
      if (apply) await db.delete(workCatalogV2).where(eq(workCatalogV2.id, row.id));
      continue;
    }

    refiled++;
    if (examples.length < 8) {
      examples.push(
        `${row.normalizedSystem}/${row.normalizedNumber}  ->  ${split.normalizedSystem}/${split.normalizedNumber}`,
      );
    }
    if (apply) {
      await db
        .update(workCatalogV2)
        .set({
          system: split.system,
          number: split.number,
          normalizedSystem: split.normalizedSystem,
          normalizedNumber: split.normalizedNumber,
        })
        .where(eq(workCatalogV2.id, row.id));
    }
  }

  console.log(apply ? 'Applied.' : 'Dry run. Pass --apply to write.');
  console.log(`
  imported catalogue rows   ${rows.length}
    re-filed                ${refiled}
    removed as duplicates   ${duplicates}
    already correct         ${unchanged}`);
  if (examples.length) console.log('\n  ' + examples.join('\n  '));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
