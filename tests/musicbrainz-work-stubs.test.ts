import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';
import { eq } from 'drizzle-orm';
import { createTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/test-database';
import { fakeSource } from './helpers/musicbrainz-fixtures';
import type { MbWork, MusicBrainzSource } from '../app/lib/musicbrainz-source';

/**
 * Draining work stubs: a stub read in full gains its composer, and a stub
 * MusicBrainz will not return as itself stays a stub but stops blocking the
 * stubs behind it.
 */

let db: TestDatabase;
let schema: typeof import('@/lib/db/schema');
let cache: typeof import('@/lib/musicbrainz-cache');

before(async () => {
  db = await createTestDatabase();
  schema = await import('@/lib/db/schema');
  cache = await import('@/lib/musicbrainz-cache');
});

beforeEach(async () => {
  await resetTestDatabase(db);
});

function source(works: Record<string, MbWork | null>, asked: string[]): MusicBrainzSource {
  return fakeSource({
    work: async (id) => {
      asked.push(id);
      return works[id] ?? null;
    },
  });
}

function composed(id: string, title: string): MbWork {
  return {
    id,
    title,
    type: 'Sonata',
    relations: [
      {
        type: 'composer',
        direction: 'backward',
        artist: { id: 'mb-mozart', name: 'Wolfgang Amadeus Mozart' },
      },
    ],
  };
}

async function stub(mbid: string, fetchedAt: string) {
  await db.insert(schema.mbWork).values({
    mbid,
    title: mbid,
    detail: 'stub',
    fetchedAt: new Date(fetchedAt),
  });
}

async function workRow(mbid: string) {
  const [row] = await db.select().from(schema.mbWork).where(eq(schema.mbWork.mbid, mbid));
  return row;
}

test('a stub read in full gains its composer', async () => {
  await stub('k545', '2026-09-21T00:00:00Z');
  const asked: string[] = [];

  const result = await cache.drainWorkStubs(
    source({ k545: composed('k545', 'Piano Sonata no. 16') }, asked),
    10,
  );

  assert.deepEqual(result, { works: 1, requests: 1, unavailable: 0 });
  const row = await workRow('k545');
  assert.equal(row.detail, 'full');
  assert.equal(row.composerMbid, 'mb-mozart');
});

test('a work MusicBrainz no longer returns stays a stub and moves to the back', async () => {
  await stub('gone', '2026-09-21T00:00:00Z');
  await stub('merged', '2026-09-21T00:00:01Z');
  await stub('k545', '2026-09-21T00:00:02Z');
  const asked: string[] = [];
  const works = {
    gone: null,
    // A merged work comes back under the MBID it was merged into.
    merged: composed('merged-into', 'Piano Sonata no. 11'),
    k545: composed('k545', 'Piano Sonata no. 16'),
  };

  const first = await cache.drainWorkStubs(source(works, asked), 2);
  assert.deepEqual(first, { works: 0, requests: 2, unavailable: 2 });
  assert.equal((await workRow('gone')).detail, 'stub');
  assert.equal((await workRow('merged')).detail, 'stub');

  const second = await cache.drainWorkStubs(source(works, asked), 2);
  assert.equal(asked[2], 'k545', 'the untried stub is read before the ones that failed');
  assert.equal(second.works, 1);
  assert.equal((await workRow('k545')).detail, 'full');
});
