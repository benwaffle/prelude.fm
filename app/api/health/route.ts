import { HEALTH_CACHE_TTL_MS, getHealthSnapshot } from '@/lib/health-snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What is actually deployed, and what it is talking to.
 *
 * Public ops telemetry: commit, reader/pipeline flags, migration count, row
 * counts, and the latest invariant sweep. Unauthenticated so cutover checks
 * and uptime probes can curl it without secrets.
 *
 * Responses are cached in memory for {@link HEALTH_CACHE_TTL_MS} so repeated
 * polls do not run seven COUNT(*) queries against Turso on every request.
 */
export async function GET() {
  return Response.json(await getHealthSnapshot());
}
