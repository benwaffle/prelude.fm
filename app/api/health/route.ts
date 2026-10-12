import { getHealthSnapshot } from '@/lib/health-snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Unauthenticated so uptime probes can curl it without secrets. */
export async function GET() {
  return Response.json(await getHealthSnapshot());
}
