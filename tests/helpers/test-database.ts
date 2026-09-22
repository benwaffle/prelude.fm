import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

/**
 * A real SQLite database built from `schema.ts`, for tests that need to prove
 * something about what the pipeline writes — foreign keys, transactions and
 * rollback behave as they do in production, which a hand-written fake cannot
 * show. Pure-function tests should not reach for this.
 *
 * It is a temporary file rather than `:memory:` because the libSQL client
 * opens a fresh connection for a transaction, and an in-memory database is
 * private to the connection that made it: the schema would vanish at the
 * first `db.transaction`.
 *
 * Node runs each test file in its own process, so the database and the
 * `@/lib/db` singleton it backs belong to a single file.
 */
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
    return db;
  })();
  return prepared;
}

/** Empties every table so one test does not inherit another's rows. */
export async function resetTestDatabase(db: TestDatabase) {
  const tables = await db.all<{ name: string }>(
    sql.raw("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"),
  );
  // Deferring the keys for the duration of one transaction lets the tables be
  // emptied in any order; the constraints are still checked at commit.
  await db.transaction(async (transaction) => {
    await transaction.run(sql.raw('pragma defer_foreign_keys = on'));
    for (const table of tables) await transaction.run(sql.raw(`delete from "${table.name}"`));
  });
}
