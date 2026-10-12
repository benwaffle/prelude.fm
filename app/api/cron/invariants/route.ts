import {
  hardViolations,
  latestInvariantResults,
  musicBrainzInvariantHealth,
  recordInvariantResults,
  runMusicBrainzInvariants,
} from '@/lib/musicbrainz-invariants';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Same definitions as the CLI and admin page. The response carries health state so callers can tell
// a clean sweep from a missed one.
function isAuthorized(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  return Boolean(cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`);
}

async function sweep() {
  const results = await runMusicBrainzInvariants();
  await recordInvariantResults(results);
  const failing = hardViolations(results);
  for (const broken of failing) {
    console.error(`MusicBrainz invariant broken: ${broken.name} (${broken.violations})`);
  }
  return {
    checked: results.length,
    violations: Object.fromEntries(
      results.filter((result) => result.violations > 0).map((r) => [r.name, r.violations]),
    ),
    health: musicBrainzInvariantHealth(await latestInvariantResults()),
  };
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const report = await sweep();
  // A hard failure is a 500 so whatever watches the schedule sees it.
  return Response.json(report, { status: report.health.state === 'red' ? 500 : 200 });
}

export const POST = GET;
