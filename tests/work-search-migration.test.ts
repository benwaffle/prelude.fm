import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { WORK_SEARCH_DDL } from '../app/lib/db/work-search';

// The tests build the index from `WORK_SEARCH_DDL`; production builds it from the migration.
test('the catalogue search migration creates the index the tests run against', () => {
  const migration = readFileSync(
    new URL('../drizzle/0038_catalogue_search.sql', import.meta.url),
    'utf8',
  );
  const statements = migration.split('--> statement-breakpoint').map((part) => part.trim());
  for (const statement of WORK_SEARCH_DDL)
    assert.ok(statements.includes(`${statement};`), statement);
});
