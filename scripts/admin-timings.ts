/**
 * How long each /admin page's reads take, and how many database round trips
 * they make. Calls the same server actions the pages call on load, with the
 * session read stubbed to the admin's user (the admin check itself still
 * reads). Reads only.
 *
 *   pnpm admin:timings           every page, three runs each
 *   pnpm admin:timings home      one page
 *   RUNS=1 pnpm admin:timings    fewer runs
 *
 * Pages run their actions at once here; in the browser Next sends one
 * action at a time, so a page that calls two actions waits for both in turn.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import { loadEnvConfig } from '@next/env';

type Load = () => Promise<unknown>;

function pageLoads(): Record<string, Load> {
  // Outside a request there are no headers and no session cookie.
  require('next/headers').headers = async () => new Headers();
  const { db } = require('@/lib/db');
  const { sql } = require('drizzle-orm');
  const { auth } = require('@/lib/auth');
  const adminUser: Promise<string> = db
    .get(
      sql`select user_id as id from account where provider_id = 'spotify' and account_id = 'benwaffle'`,
    )
    .then((row: { id: string }) => row.id);
  auth.api.getSession = async () => ({ user: { id: await adminUser } });

  const inboxView = require('@/app/admin/actions/inbox-view');
  const bot = require('@/app/admin/actions/bot');
  const releaseSubmissions = require('@/app/admin/actions/release-submissions');
  const readiness = require('@/app/admin/actions/readiness');
  const gateway = require('@/app/admin/actions/gateway');
  const coverage = require('@/app/admin/actions/coverage');
  const cacheHealth = require('@/app/admin/actions/cache-health');
  const proposals = require('@/app/admin/actions/work-proposals');

  // The gateway bar sits on every page.
  const page =
    (...loads: Load[]): Load =>
    () =>
      Promise.all([gateway.getGatewayStatus(), ...loads.map((load) => load())]);
  const list = (section: string, ...extra: Load[]) =>
    page(() => inboxView.getContributions(undefined, section), ...extra);

  return {
    home: page(() => readiness.getAdminHome()),
    missing: list('missing'),
    misaligned: list('misaligned'),
    work: list('work', () => proposals.getWorkProposals()),
    contested: list('contested'),
    isrc: list('isrc', () => bot.getBotStatus()),
    barcodes: list('barcodes', () => bot.getBotStatus()),
    streaming: list('streaming'),
    submitted: list('submitted'),
    albums: page(() => coverage.getAlbums()),
    corrections: page(() => releaseSubmissions.getReleaseCorrections()),
    checks: page(() => cacheHealth.getCacheHealth()),
  };
}

async function main() {
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required (put it in .env.local or export it)');
  }

  // libSQL over HTTP makes one request per round trip.
  let trips = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    trips++;
    return realFetch(...args);
  }) as typeof fetch;

  const loads = pageLoads();
  const only = process.argv[2];
  if (only && !(only in loads))
    throw new Error(`No page ${only}: ${Object.keys(loads).join(', ')}`);
  const runs = Number(process.env.RUNS ?? 3);

  // Open the connection first so the first page does not pay for it.
  await loads.checks();
  for (const [name, load] of Object.entries(loads)) {
    if (only && name !== only) continue;
    const results: string[] = [];
    for (let i = 0; i < runs; i++) {
      trips = 0;
      const start = performance.now();
      await load();
      results.push(`${Math.round(performance.now() - start)}ms/${trips}`);
    }
    console.log(`${name.padEnd(12)} ${results.join('  ')}`);
  }
  console.log('(each run: milliseconds/round trips; caches warm up after the first run)');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
