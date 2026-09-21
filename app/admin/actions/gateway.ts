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
  /** Requests per day over the last fortnight, oldest first. */
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

/**
 * Stop or resume a channel.
 *
 * `all` is the whole gateway. The note is what the next person to look at this
 * page needs in order to know whether it is safe to turn back on, so it is
 * kept rather than being a transient confirmation.
 */
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

/** Raise or lower a channel's daily cap. Null restores the built-in default. */
export async function setChannelCap(channel: string, dailyCap: number | null) {
  await checkAuth();
  if (channel !== 'all' && !isMusicBrainzChannel(channel)) {
    throw new Error(`Unknown channel: ${channel}`);
  }
  if (dailyCap !== null && (!Number.isInteger(dailyCap) || dailyCap < 0)) {
    throw new Error('A daily cap must be a whole number of requests');
  }

  await db
    .insert(mbGatewayControl)
    .values({ channel, dailyCap, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: mbGatewayControl.channel,
      set: { dailyCap, updatedAt: new Date() },
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
