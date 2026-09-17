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
import { db } from '@/lib/db';
import {
  composer,
  metadataMigrationAudit,
  musicbrainzFact,
  work,
  workPartV2,
} from '@/lib/db/schema';
import { normalizeMetadataText } from '@/lib/classical-normalization';

const apply = process.argv.includes('--apply');
const showDetails = process.argv.includes('--details');

type Outcome = 'filled' | 'agreed' | 'conflict' | 'skipped';

type Plan = {
  field: string;
  entityId: number;
  current: string | null;
  incoming: string;
  outcome: Outcome;
};

/** MusicBrainz work types are Capitalised; our `form` column is lower case. */
function formFromWorkType(value: string) {
  return value.toLocaleLowerCase();
}

function sameText(a: string | null, b: string) {
  return normalizeMetadataText(a) === normalizeMetadataText(b);
}

function sameYear(a: number | null, b: string) {
  return a != null && String(a) === b.trim();
}

async function load(entityType: 'composer' | 'work' | 'work_part', field: string) {
  return db
    .select({ entityId: musicbrainzFact.entityId, value: musicbrainzFact.value })
    .from(musicbrainzFact)
    .where(and(eq(musicbrainzFact.entityType, entityType), eq(musicbrainzFact.field, field)));
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
  const facts = await load('composer', field);
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
    if (held == null) {
      plans.push({
        field,
        entityId: fact.entityId,
        current: null,
        incoming: fact.value,
        outcome: 'filled',
      });
      if (apply) {
        await db
          .update(composer)
          .set(isBirth ? { birthYear: year } : { deathYear: year })
          .where(eq(composer.id, fact.entityId));
        if (isBirth) await clearStaleDecision('composer', String(fact.entityId), 'no_birth_year');
      }
    } else if (sameYear(held, fact.value)) {
      plans.push({
        field,
        entityId: fact.entityId,
        current: String(held),
        incoming: fact.value,
        outcome: 'agreed',
      });
    } else {
      plans.push({
        field,
        entityId: fact.entityId,
        current: String(held),
        incoming: fact.value,
        outcome: 'conflict',
      });
    }
  }
  return plans;
}

async function promoteWorkForm() {
  const facts = await load('work', 'work_type');
  const current = new Map(
    (await db.select({ id: work.id, form: work.form }).from(work)).map((r) => [r.id, r.form]),
  );
  const plans: Plan[] = [];
  for (const fact of facts) {
    if (!current.has(fact.entityId)) continue;
    const held = current.get(fact.entityId) ?? null;
    const incoming = formFromWorkType(fact.value);
    if (held == null) {
      plans.push({
        field: 'form',
        entityId: fact.entityId,
        current: null,
        incoming,
        outcome: 'filled',
      });
      if (apply) {
        await db.update(work).set({ form: incoming }).where(eq(work.id, fact.entityId));
        await clearStaleDecision('work', String(fact.entityId), 'no_form');
      }
    } else if (sameText(held, incoming)) {
      plans.push({
        field: 'form',
        entityId: fact.entityId,
        current: held,
        incoming,
        outcome: 'agreed',
      });
    } else {
      // Our parser is often more specific than MusicBrainz's 29-term
      // vocabulary ("chorale prelude" where MusicBrainz has none), so a
      // difference here is usually us being better, not us being wrong.
      plans.push({
        field: 'form',
        entityId: fact.entityId,
        current: held,
        incoming,
        outcome: 'conflict',
      });
    }
  }
  return plans;
}

async function promotePartTitles() {
  const facts = await load('work_part', 'part_title');
  const current = new Map(
    (await db.select({ id: workPartV2.id, title: workPartV2.title }).from(workPartV2)).map((r) => [
      r.id,
      r.title,
    ]),
  );
  const plans: Plan[] = [];
  for (const fact of facts) {
    if (!current.has(fact.entityId)) continue;
    const held = current.get(fact.entityId) ?? null;
    if (held == null || held.trim() === '') {
      plans.push({
        field: 'part_title',
        entityId: fact.entityId,
        current: null,
        incoming: fact.value,
        outcome: 'filled',
      });
      if (apply) {
        await db
          .update(workPartV2)
          .set({ title: fact.value })
          .where(eq(workPartV2.id, fact.entityId));
        await clearStaleDecision('work_part_v2', String(fact.entityId), 'no_part_name');
      }
    } else if (sameText(held, fact.value)) {
      plans.push({
        field: 'part_title',
        entityId: fact.entityId,
        current: held,
        incoming: fact.value,
        outcome: 'agreed',
      });
    } else {
      plans.push({
        field: 'part_title',
        entityId: fact.entityId,
        current: held,
        incoming: fact.value,
        outcome: 'conflict',
      });
    }
  }
  return plans;
}

async function main() {
  const factCount = await db.select({ n: sql<number>`count(*)` }).from(musicbrainzFact);
  if (!factCount[0]?.n) {
    console.log('No MusicBrainz facts recorded yet — run `pnpm mb:backfill works` first.');
    return;
  }

  const plans = [
    ...(await promoteComposerYears('birth_year')),
    ...(await promoteComposerYears('death_year')),
    ...(await promoteWorkForm()),
    ...(await promotePartTitles()),
  ];

  const summary = new Map<string, Record<Outcome, number>>();
  for (const plan of plans) {
    const row = summary.get(plan.field) ?? { filled: 0, agreed: 0, conflict: 0, skipped: 0 };
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
