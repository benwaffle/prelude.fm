import {
  hardViolations,
  latestInvariantResults,
  musicBrainzInvariantHealth,
  recordInvariantResults,
  runMusicBrainzInvariants,
} from '@/lib/musicbrainz-invariants';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * The full invariant sweep, on a schedule.
 *
 * The worker runs the cheap checks after every album, which catches the
 * damage a pass can do to itself. The expensive ones — the whole-table scans
 * — only ever ran when somebody typed a command, which means in practice
 * they ran when somebody already suspected a problem.
 *
 * Same definitions as the CLI and the admin page, so there is one answer to
 * the question rather than three. The response carries the health state, so
 * whatever calls this can tell a clean sweep from a sweep that did not
 * happen.
 */
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
  // A hard failure is a 500 so that whatever is watching the schedule sees
  // it, rather than a 200 carrying bad news nobody reads.
  return Response.json(report, { status: report.health.state === 'red' ? 500 : 200 });
}

export const POST = GET;
