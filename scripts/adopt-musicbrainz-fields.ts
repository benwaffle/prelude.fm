/**
 * Adopt MusicBrainz's form and movement titles, keeping the parser's.
 *
 * Our `work.form` and `work_part_v2.title` were written by the LLM from
 * Spotify track text. MusicBrainz's are stated by people who were looking at
 * the work. Treating a disagreement between the two as a decision for a human
 * gives the guess equal standing with the checked value, and there are
 * thousands of them.
 *
 * So MusicBrainz wins, and the parser's value moves to `parser_form` /
 * `parser_title` rather than being thrown away: it is more specific than
 * MusicBrainz's fixed vocabulary — "violin concerto" against "concerto" — and
 * that is worth keeping for recommendation and grouping, which do not have to
 * be right.
 *
 * Dry run by default. `--apply` writes.
 *
 *   pnpm metadata:adopt-mb [--apply]
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
  const { work, workPartV2, metadataMigrationAudit } = schema;
  const {
    abbreviates,
    decidePromotion,
    formFromWorkType,
    movementTitleFromMusicBrainz,
    textuallyEqual,
  } = promotion;
  const { eq, sql } = drizzle;

  const counts = {
    formReplaced: 0,
    formFilled: 0,
    formAgreed: 0,
    formCleared: 0,
    titleReplaced: 0,
    titleFilled: 0,
    titleAgreed: 0,
    titleRejected: 0,
    titleKeptFuller: 0,
  };
  const examples: string[] = [];

  /* ------------------------------------------------------------- forms --- */

  const formRows = await db.all<{
    id: number;
    title: string;
    form: string | null;
    parserForm: string | null;
    mbType: string;
  }>(sql`
    select w.id, w.title, w.form, w.parser_form as parserForm, f.value as mbType
      from work w
      join musicbrainz_fact f
        on f.entity_type = 'work' and f.field = 'work_type' and f.entity_id = w.id
  `);

  for (const row of formRows) {
    const incoming = formFromWorkType(row.mbType);
    const outcome = decidePromotion(row.form, incoming, textuallyEqual, 'musicbrainz-wins');
    if (outcome === 'agree') {
      counts.formAgreed++;
      continue;
    }
    if (outcome === 'fill') counts.formFilled++;
    if (outcome === 'replace') {
      counts.formReplaced++;
      if (examples.length < 6) examples.push(`form  "${row.form}" -> "${incoming}"  ${row.title}`);
    }
    if (apply) {
      await db
        .update(work)
        .set({ form: incoming, parserForm: row.parserForm ?? row.form })
        .where(eq(work.id, row.id));
    }
  }

  /*
   * Works MusicBrainz has no type for keep nothing in `form`: the parser's
   * guess moves aside and the column is left empty, which is the honest
   * state. `metadata:validate` already counts a missing form as backlog, so
   * the gap stays visible rather than being papered over by a guess.
   */
  const untyped = await db.all<{ id: number; form: string }>(sql`
    select w.id, w.form from work w
     where w.form is not null and trim(w.form) <> ''
       and not exists (select 1 from musicbrainz_fact f
                        where f.entity_type = 'work' and f.field = 'work_type' and f.entity_id = w.id)
  `);
  counts.formCleared = untyped.length;
  if (apply) {
    for (const row of untyped) {
      await db
        .update(work)
        .set({ form: null, parserForm: sql`coalesce(${work.parserForm}, ${row.form})` })
        .where(eq(work.id, row.id));
    }
  }

  /* ---------------------------------------------------------- movements --- */

  const titleRows = await db.all<{
    id: number;
    label: string | null;
    title: string | null;
    parserTitle: string | null;
    mbTitle: string;
  }>(sql`
    select p.id, p.label, p.title, p.parser_title as parserTitle, f.value as mbTitle
      from work_part_v2 p
      join musicbrainz_fact f
        on f.entity_type = 'work_part' and f.field = 'part_title' and f.entity_id = p.id
  `);

  for (const row of titleRows) {
    // Strips the movement number we already hold in `label` and refuses a
    // string still carrying a catalogue reference, which is a work title
    // rather than a movement title.
    const incoming = movementTitleFromMusicBrainz(row.mbTitle, row.label);
    if (!incoming) {
      counts.titleRejected++;
      continue;
    }
    /*
     * MusicBrainz wins because ours is a guess — but not when the guess is
     * the fuller of the two. "Sicut Locutus" against our "Sicut lucutus est
     * ad Patres nostros" is MusicBrainz abbreviating, and "Rondo. Allegro"
     * drops the "– Presto" that ours records. Adopting those would be
     * throwing away information in the name of provenance.
     */
    if (row.title && abbreviates(incoming, row.title)) {
      counts.titleKeptFuller++;
      continue;
    }

    const outcome = decidePromotion(row.title, incoming, textuallyEqual, 'musicbrainz-wins');
    if (outcome === 'agree') {
      counts.titleAgreed++;
      continue;
    }
    if (outcome === 'fill') counts.titleFilled++;
    if (outcome === 'replace') {
      counts.titleReplaced++;
      if (examples.length < 12) examples.push(`title "${row.title}" -> "${incoming}"`);
    }
    if (apply) {
      await db
        .update(workPartV2)
        .set({ title: incoming, parserTitle: row.parserTitle ?? row.title })
        .where(eq(workPartV2.id, row.id));
    }
  }

  if (apply) {
    await db
      .insert(metadataMigrationAudit)
      .values({
        entityType: 'policy',
        sourceId: 'musicbrainz-wins:form+part_title',
        decision: 'adopted',
        reason:
          `MusicBrainz now owns work.form and work_part_v2.title. ` +
          `Replaced ${counts.formReplaced} forms and ${counts.titleReplaced} movement titles; ` +
          `cleared ${counts.formCleared} forms MusicBrainz has no type for. ` +
          `The parser's values are preserved in work.parser_form and work_part_v2.parser_title.`,
      })
      .onConflictDoNothing();
  }

  console.log(apply ? 'Applied.' : 'Dry run. Pass --apply to write.');
  console.log(`
  form
    replaced by MusicBrainz   ${counts.formReplaced}
    filled where we had none  ${counts.formFilled}
    already agreed            ${counts.formAgreed}
    cleared (no MB type)      ${counts.formCleared}
  movement titles
    replaced by MusicBrainz   ${counts.titleReplaced}
    filled where we had none  ${counts.titleFilled}
    already agreed            ${counts.titleAgreed}
    MB value unusable, kept   ${counts.titleRejected}
    ours said more, kept      ${counts.titleKeptFuller}`);
  if (examples.length) console.log('\n  ' + examples.join('\n  '));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
