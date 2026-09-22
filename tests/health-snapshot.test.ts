import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEALTH_CACHE_TTL_MS,
  getHealthSnapshot,
  resetHealthCache,
  type HealthSnapshot,
} from '../app/lib/health-snapshot';

const SNAPSHOT: HealthSnapshot = {
  commit: 'abc123',
  branch: 'master',
  environment: 'production',
  reader: 'musicbrainz',
  pipeline: 'legacy',
  migrations: { count: 20, latest: 1 },
  rows: {
    spotifyTracks: 10201,
    anchors: 6683,
    releases: 1,
    recordings: 6820,
    works: 5693,
    submissions: 0,
    queued: 0,
  },
  invariants: { state: 'green', failing: [], stale: [], neverRun: [] },
};

test('getHealthSnapshot loads once and serves from cache within TTL', async () => {
  resetHealthCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return SNAPSHOT;
  };

  const first = await getHealthSnapshot({ now: 1_000, load });
  const second = await getHealthSnapshot({ now: 1_000 + HEALTH_CACHE_TTL_MS - 1, load });

  assert.deepEqual(first, SNAPSHOT);
  assert.deepEqual(second, SNAPSHOT);
  assert.equal(loads, 1);
});

test('getHealthSnapshot reloads after TTL expires', async () => {
  resetHealthCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { ...SNAPSHOT, commit: `load-${loads}` };
  };

  await getHealthSnapshot({ now: 0, ttlMs: 10_000, load });
  const refreshed = await getHealthSnapshot({ now: 10_000, ttlMs: 10_000, load });

  assert.equal(refreshed.commit, 'load-2');
  assert.equal(loads, 2);
});

test('resetHealthCache forces the next request to reload', async () => {
  resetHealthCache();
  let loads = 0;
  const load = async () => {
    loads += 1;
    return SNAPSHOT;
  };

  await getHealthSnapshot({ now: 0, load });
  resetHealthCache();
  await getHealthSnapshot({ now: 0, load });

  assert.equal(loads, 2);
});
