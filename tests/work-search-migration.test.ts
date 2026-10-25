import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ALBUM_SEARCH_DDL } from '../app/lib/db/album-search';
import { WORK_SEARCH_DDL } from '../app/lib/db/work-search';

// The tests build the indexes from these statements; production builds them from the migrations.
for (const [migration, ddl] of [
  ['0038_catalogue_search', WORK_SEARCH_DDL],
  ['0039_album_search', ALBUM_SEARCH_DDL],
] as const) {
  test(`migration ${migration} creates the index the tests run against`, () => {
    const text = readFileSync(new URL(`../drizzle/${migration}.sql`, import.meta.url), 'utf8');
    const statements = text.split('--> statement-breakpoint').map((part) => part.trim());
    for (const statement of ddl) assert.ok(statements.includes(`${statement};`), statement);
  });
}
