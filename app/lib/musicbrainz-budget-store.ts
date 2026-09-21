/**
 * The database-backed MusicBrainz budget.
 *
 * Kept apart from the scheduler so that `musicbrainz-gateway.ts` — which every
 * MusicBrainz read imports — does not drag a database client behind it, and so
 * the scheduler's own tests need no database at all. The gateway loads this
 * module lazily and falls back to counting in memory if it cannot.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mbGatewayControl, mbRequestBudget } from '@/lib/db/schema';
import type {
  MusicBrainzBudgetStore,
  MusicBrainzChannel,
  MusicBrainzControl,
} from './musicbrainz-budget';

export function createMusicBrainzBudgetStore(): MusicBrainzBudgetStore {
  return {
    async spend(day: string, channel: MusicBrainzChannel) {
      const [row] = await db
        .insert(mbRequestBudget)
        .values({ day, channel, requests: 1 })
        .onConflictDoUpdate({
          target: [mbRequestBudget.day, mbRequestBudget.channel],
          set: { requests: sql`${mbRequestBudget.requests} + 1` },
        })
        .returning({ requests: mbRequestBudget.requests });
      return row?.requests ?? 1;
    },

    async refund(day: string, channel: MusicBrainzChannel) {
      await db
        .update(mbRequestBudget)
        .set({ requests: sql`max(0, ${mbRequestBudget.requests} - 1)` })
        .where(and(eq(mbRequestBudget.day, day), eq(mbRequestBudget.channel, channel)));
    },

    async usage(day: string) {
      const rows = await db
        .select({ channel: mbRequestBudget.channel, requests: mbRequestBudget.requests })
        .from(mbRequestBudget)
        .where(eq(mbRequestBudget.day, day));
      return Object.fromEntries(rows.map((row) => [row.channel, row.requests]));
    },

    async controls() {
      const rows = await db
        .select({
          channel: mbGatewayControl.channel,
          paused: mbGatewayControl.paused,
          dailyCap: mbGatewayControl.dailyCap,
          note: mbGatewayControl.note,
        })
        .from(mbGatewayControl);
      const out: Record<string, MusicBrainzControl> = {};
      for (const row of rows) {
        out[row.channel] = {
          paused: Boolean(row.paused),
          dailyCap: row.dailyCap ?? null,
          note: row.note ?? null,
        };
      }
      return out;
    },
  };
}
