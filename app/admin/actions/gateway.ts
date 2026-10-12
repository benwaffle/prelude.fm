'use server';

import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mbGatewayControl, mbRequestBudget } from '@/lib/db/schema';
import {
  invalidateMusicBrainzControls,
  musicbrainzGatewayStatus,
  type MusicBrainzGatewayStatus,
} from '@/lib/musicbrainz-gateway';
import { isMusicBrainzChannel } from '@/lib/musicbrainz-budget';
import { checkAuth } from './auth';

export type GatewayView = MusicBrainzGatewayStatus & {
  history: { day: string; requests: number }[];
};

export async function getGatewayStatus(): Promise<GatewayView> {
  await checkAuth();
  const status = await musicbrainzGatewayStatus();
  const history = await db
    .select({ day: mbRequestBudget.day, requests: sql<number>`sum(${mbRequestBudget.requests})` })
    .from(mbRequestBudget)
    .groupBy(mbRequestBudget.day)
    .orderBy(mbRequestBudget.day)
    .limit(14);
  return { ...status, history };
}

/** The note is kept so the next person knows whether it is safe to turn back on. */
export async function setChannelPaused(channel: string, paused: boolean, note?: string) {
  await checkAuth();
  if (channel !== 'all' && !isMusicBrainzChannel(channel)) {
    throw new Error(`Unknown channel: ${channel}`);
  }

  await db
    .insert(mbGatewayControl)
    .values({ channel, paused, note: note ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: mbGatewayControl.channel,
      set: { paused, note: note ?? null, updatedAt: new Date() },
    });

  invalidateMusicBrainzControls();
  return getGatewayStatus();
}

export async function clearChannelControl(channel: string) {
  await checkAuth();
  await db.delete(mbGatewayControl).where(eq(mbGatewayControl.channel, channel));
  invalidateMusicBrainzControls();
  return getGatewayStatus();
}
