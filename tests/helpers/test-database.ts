import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

// A temp file, not `:memory:`: libSQL opens a fresh connection per transaction, which wouldn't see
// an in-memory schema.
let prepared: Promise<TestDatabase> | null = null;

export type TestDatabase = Awaited<ReturnType<typeof importDatabase>>;

async function importDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'classical-test-db-'));
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
  process.env.TURSO_DATABASE_URL = `file:${join(directory, 'test.db')}`;
  delete process.env.TURSO_AUTH_TOKEN;
  const { db } = await import('@/lib/db');
  return db;
}

export function createTestDatabase() {
  prepared ??= (async () => {
    const db = await importDatabase();
    const schema = await import('@/lib/db/schema');
    const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import('drizzle-kit/api');
    const statements = await generateSQLiteMigration(
      await generateSQLiteDrizzleJson({}),
      await generateSQLiteDrizzleJson(schema as never),
    );
    for (const statement of statements) await db.run(sql.raw(statement));
    // What the schema can't describe, as migrations create it.
    const { WORK_SEARCH_DDL } = await import('@/lib/db/work-search');
    const { ALBUM_SEARCH_DDL } = await import('@/lib/db/album-search');
    for (const statement of [...WORK_SEARCH_DDL, ...ALBUM_SEARCH_DDL]) {
      await db.run(sql.raw(statement));
    }
    return db;
  })();
  return prepared;
}

export async function resetTestDatabase(db: TestDatabase) {
  const tables = await db.all<{ name: string }>(
    // Not a full-text index's own tables (`mb_work_search_data`, ...): emptying the index is how
    // those are cleared.
    sql.raw(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%\\_search\\_%' escape '\\'",
    ),
  );
  // Deferred keys let tables be emptied in any order; constraints are still checked at commit.
  await db.transaction(async (transaction) => {
    await transaction.run(sql.raw('pragma defer_foreign_keys = on'));
    for (const table of tables) await transaction.run(sql.raw(`delete from "${table.name}"`));
  });
}
