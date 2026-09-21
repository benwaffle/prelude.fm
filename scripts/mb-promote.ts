/**
 * Phase 2: let MusicBrainz fill gaps the parser left.
 *
 * Only empty fields are written. Where we already hold a value and MusicBrainz
 * disagrees, nothing is changed and the disagreement is reported: one of the
 * two is wrong, and picking automatically would destroy the evidence that they
 * ever differed. Agreement is counted too, because it is the cheapest
 * confirmation the parser is working.
 *
 *   pnpm mb:promote            report what would change
 *   pnpm mb:promote --apply    write it
 */
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from '@/lib/db';
import {
  composer,
  mbArtist,
  mbWork,
  metadataMigrationAudit,
  work,
  workPartV2,
} from '@/lib/db/schema';
import {
  abbreviates,
  decidePromotion,
  formFromWorkType,
  movementTitleFromMusicBrainz,
  workTitleFromMusicBrainz,
  chooseGroupTitles,
  textuallyEqual,
  yearsEqual,
} from '@/lib/musicbrainz-promotion';

const apply = process.argv.includes('--apply');
const showDetails = process.argv.includes('--details');

type Outcome = 'filled' | 'agreed' | 'replaced' | 'conflict' | 'skipped';

type Plan = {
  field: string;
  entityId: number;
  current: string | null;
  incoming: string;
  outcome: Outcome;
};

/**
 * What MusicBrainz says, read from the cache.
 *
 * This used to read `musicbrainz_fact`, a key-value shadow of the same
 * information filled by a backfill that no longer exists. The cache holds all
 * of it natively and reaches further — every field below has a column, and
 * the part titles in particular reach movements the fact table never covered,
 * because anchoring finds a recording's work even where no per-work fact was
 * ever written.
 *
 * Each reader returns the same `{ entityId, value }` shape the policies
 * already consume, so changing the source changed nothing about the rules.
 */
type Fact = { entityId: number; value: string };

/** Composer dates, via the artist their MBID points at. */
async function composerYears(field: 'birth_year' | 'death_year'): Promise<Fact[]> {
  const column = field === 'birth_year' ? mbArtist.beginYear : mbArtist.endYear;
  const rows = await db
    .select({ entityId: composer.id, year: column })
    .from(composer)
    .innerJoin(mbArtist, eq(mbArtist.mbid, composer.musicbrainzId))
    .where(sql`${column} is not null`);
  return rows.flatMap((row) =>
    row.year === null ? [] : [{ entityId: row.entityId, value: String(row.year) }],
  );
}

/** The MusicBrainz work type, for works we have linked. */
async function workTypes(): Promise<Fact[]> {
  const rows = await db
    .select({ entityId: work.id, value: mbWork.type })
    .from(work)
    .innerJoin(mbWork, eq(mbWork.mbid, work.musicbrainzId))
    .where(sql`${mbWork.type} is not null`);
  return rows.flatMap((row) => (row.value ? [{ entityId: row.entityId, value: row.value }] : []));
}

/**
 * Work titles, with the collection prefix and catalogue reference removed.
 *
 * The transform runs here rather than at write time, so there is one place
 * that decides how a MusicBrainz title becomes one of ours.
 */
async function workTitles(): Promise<Fact[]> {
  const parent = alias(mbWork, 'parent_work');
  const rows = await db
    .select({ entityId: work.id, title: mbWork.title, parentTitle: parent.title })
    .from(work)
    .innerJoin(mbWork, eq(mbWork.mbid, work.musicbrainzId))
    .leftJoin(parent, eq(parent.mbid, mbWork.parentMbid));

  return rows.flatMap((row) => {
    const title = workTitleFromMusicBrainz(row.title, row.parentTitle);
    return title ? [{ entityId: row.entityId, value: title }] : [];
  });
}

/**
 * Movement titles, reached through the recordings a part's tracks are
 * anchored to.
 *
 * A part reached through two different MusicBrainz works has no single
 * answer, so it is dropped rather than resolved arbitrarily.
 */
async function partTitles(): Promise<Fact[]> {
  const rows = await db.all<{ entityId: number; label: string | null; title: string }>(sql`
    select distinct wp.id as entityId, wp.label, mw.title
      from work_part_v2 wp
      join track_work_part_v2 twp on twp.work_part_id = wp.id
      join track_recording tr on tr.spotify_track_id = twp.spotify_track_id
      join mb_recording_work rw on rw.recording_mbid = tr.recording_mbid
      join mb_work mw on mw.mbid = rw.work_mbid
  `);

  const byPart = new Map<number, string | null>();
  const contested = new Set<number>();
  for (const row of rows) {
    const title = movementTitleFromMusicBrainz(row.title, row.label);
    if (!title) continue;
    const seen = byPart.get(row.entityId);
    if (seen !== undefined && seen !== title) contested.add(row.entityId);
    byPart.set(row.entityId, title);
  }

  return [...byPart.entries()].flatMap(([entityId, value]) =>
    value && !contested.has(entityId) ? [{ entityId, value }] : [],
  );
}

/**
 * A gap closed by real data is no longer closed by a ruling that it did not
 * exist. Leaving the old decision behind would tell a future reader that we
 * had looked and found nothing, which would no longer be true.
 */
async function clearStaleDecision(entityType: string, sourceId: string, decision: string) {
  if (!apply) return;
  await db
    .delete(metadataMigrationAudit)
    .where(
      and(
        eq(metadataMigrationAudit.entityType, entityType),
        eq(metadataMigrationAudit.sourceId, sourceId),
        eq(metadataMigrationAudit.decision, decision),
      ),
    );
}

async function promoteComposerYears(field: 'birth_year' | 'death_year') {
  const isBirth = field === 'birth_year';
  const facts = await composerYears(field);
  const current = new Map(
    (
      await db
        .select({ id: composer.id, birth: composer.birthYear, death: composer.deathYear })
        .from(composer)
    ).map((r) => [r.id, isBirth ? r.birth : r.death]),
  );

  const plans: Plan[] = [];
  for (const fact of facts) {
    if (!current.has(fact.entityId)) continue;
    const held = current.get(fact.entityId) ?? null;
    const year = Number(fact.value);
    if (!Number.isInteger(year)) continue;

    const outcome = decidePromotion(held == null ? null : String(held), fact.value, yearsEqual);
    plans.push({
      field,
      entityId: fact.entityId,
      current: held == null ? null : String(held),
      incoming: fact.value,
      outcome: outcome === 'fill' ? 'filled' : outcome === 'agree' ? 'agreed' : 'conflict',
    });

    if (outcome === 'fill' && apply) {
      await db
        .update(composer)
        .set(isBirth ? { birthYear: year } : { deathYear: year })
        .where(eq(composer.id, fact.entityId));
      if (isBirth) await clearStaleDecision('composer', String(fact.entityId), 'no_birth_year');
    }
  }
  return plans;
}

async function promoteWorkForm() {
  const facts = await workTypes();
  const current = new Map(
    (await db.select({ id: work.id, form: work.form }).from(work)).map((r) => [r.id, r.form]),
  );

  const plans: Plan[] = [];
  for (const fact of facts) {
    if (!current.has(fact.entityId)) continue;
    const held = current.get(fact.entityId) ?? null;
    const incoming = formFromWorkType(fact.value);

    /*
     * MusicBrainz owns `form`. Ours came from the parser reading a Spotify
     * track title, and although it is often the more specific of the two —
     * "violin concerto" where MusicBrainz says "concerto" — specific is not
     * the same as checked. The parser's value is kept in `parser_form` for
     * the things that do not have to be right, like grouping and
     * recommendation.
     */
    const outcome = decidePromotion(held, incoming, textuallyEqual, 'musicbrainz-wins');
    plans.push({
      field: 'form',
      entityId: fact.entityId,
      current: held,
      incoming,
      outcome:
        outcome === 'fill'
          ? 'filled'
          : outcome === 'agree'
            ? 'agreed'
            : outcome === 'replace'
              ? 'replaced'
              : 'conflict',
    });

    if ((outcome === 'fill' || outcome === 'replace') && apply) {
      await db
        .update(work)
        .set({ form: incoming, parserForm: sql`coalesce(parser_form, form)` })
        .where(eq(work.id, fact.entityId));
      await clearStaleDecision('work', String(fact.entityId), 'no_form');
    }
  }
  return plans;
}

async function promotePartTitles() {
  const facts = await partTitles();
  const current = new Map(
    (
      await db
        .select({ id: workPartV2.id, title: workPartV2.title, label: workPartV2.label })
        .from(workPartV2)
    ).map((r) => [r.id, r]),
  );

  const plans: Plan[] = [];
  let unusable = 0;
  for (const fact of facts) {
    const row = current.get(fact.entityId);
    if (!row) continue;

    // MusicBrainz keeps numbering inside the title and sometimes names the
    // whole work; neither belongs in a column we render beside our own label.
    const incoming = movementTitleFromMusicBrainz(fact.value, row.label);
    if (!incoming) {
      unusable++;
      continue;
    }

    /*
     * MusicBrainz owns the movement title too, with one exception: it does
     * not get to shorten one. "Sicut Locutus" against our "Sicut lucutus est
     * ad Patres nostros" is an abbreviation, not a correction, and adopting
     * it would lose text in the name of provenance.
     */
    if (row.title && abbreviates(incoming, row.title)) {
      unusable++;
      continue;
    }

    const outcome = decidePromotion(row.title, incoming, textuallyEqual, 'musicbrainz-wins');
    plans.push({
      field: 'part_title',
      entityId: fact.entityId,
      current: row.title,
      incoming,
      outcome:
        outcome === 'fill'
          ? 'filled'
          : outcome === 'agree'
            ? 'agreed'
            : outcome === 'replace'
              ? 'replaced'
              : 'conflict',
    });

    if ((outcome === 'fill' || outcome === 'replace') && apply) {
      await db
        .update(workPartV2)
        .set({ title: incoming, parserTitle: sql`coalesce(parser_title, title)` })
        .where(eq(workPartV2.id, fact.entityId));
      await clearStaleDecision('work_part_v2', String(fact.entityId), 'no_part_name');
    }
  }
  if (unusable) {
    console.log(
      `${unusable} MusicBrainz part titles named a work rather than a movement and were discarded.`,
    );
  }
  return plans;
}

/**
 * Work titles, decided a group at a time.
 *
 * Unlike every other field this one is never empty, so "fill the gap" does not
 * apply: there is always something to overwrite, and overwriting on preference
 * would rewrite the catalogue into somebody else's house style. The case worth
 * fixing is a title shared by several works, which therefore names none of
 * them — and whether MusicBrainz fixes it can only be judged across the whole
 * group, so that is how it is judged.
 */
async function promoteWorkTitles() {
  const facts = new Map((await workTitles()).map((f) => [f.entityId, f.value]));
  const rows = await db
    .select({ id: work.id, title: work.title, composerId: work.composerId })
    .from(work);

  const groups = new Map<string, { id: number; ourTitle: string; incoming: string | null }[]>();
  for (const row of rows) {
    const key = `${row.composerId}:${normaliseTitle(row.title)}`;
    const member = { id: row.id, ourTitle: row.title, incoming: facts.get(row.id) ?? null };
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }

  const plans: Plan[] = [];
  for (const members of groups.values()) {
    const chosen = chooseGroupTitles(members);
    for (const member of members) {
      if (!member.incoming) continue;
      const replacement = chosen.get(member.id);
      if (!replacement) {
        plans.push({
          field: 'work_title',
          entityId: member.id,
          current: member.ourTitle,
          incoming: member.incoming,
          outcome: textuallyEqual(member.ourTitle, member.incoming) ? 'agreed' : 'conflict',
        });
        continue;
      }
      plans.push({
        field: 'work_title',
        entityId: member.id,
        current: member.ourTitle,
        incoming: replacement,
        outcome: 'filled',
      });
      if (apply) {
        await db.update(work).set({ title: replacement }).where(eq(work.id, member.id));
      }
    }
  }
  return plans;
}

function normaliseTitle(value: string) {
  return value.trim().toLocaleLowerCase();
}

async function main() {
  const [cached] = await db.select({ n: sql<number>`count(*)` }).from(mbWork);
  if (!cached?.n) {
    console.log('The MusicBrainz cache is empty — run `pnpm mb:ingest albums` first.');
    return;
  }

  const plans = [
    ...(await promoteComposerYears('birth_year')),
    ...(await promoteComposerYears('death_year')),
    ...(await promoteWorkForm()),
    ...(await promotePartTitles()),
    ...(await promoteWorkTitles()),
  ];

  const summary = new Map<string, Record<Outcome, number>>();
  for (const plan of plans) {
    const row = summary.get(plan.field) ?? {
      filled: 0,
      agreed: 0,
      replaced: 0,
      conflict: 0,
      skipped: 0,
    };
    row[plan.outcome]++;
    summary.set(plan.field, row);
  }

  console.log(apply ? 'Applied:' : 'Dry run — nothing written. Re-run with --apply.');
  console.table(
    [...summary.entries()].map(([field, row]) => ({
      field,
      filled: row.filled,
      agreed: row.agreed,
      conflict: row.conflict,
    })),
  );

  const conflicts = plans.filter((p) => p.outcome === 'conflict');
  if (conflicts.length) {
    console.log(
      `\n${conflicts.length} disagreements left untouched. These are not necessarily errors —\n` +
        'our parser is frequently more specific than MusicBrainz — but each is worth a look.',
    );
    for (const conflict of conflicts.slice(0, showDetails ? conflicts.length : 15)) {
      console.log(
        `  ${conflict.field} #${conflict.entityId}: ours=${JSON.stringify(conflict.current)} mb=${JSON.stringify(conflict.incoming)}`,
      );
    }
    if (!showDetails && conflicts.length > 15)
      console.log(`  ... ${conflicts.length - 15} more (--details)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
