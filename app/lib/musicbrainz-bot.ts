/**
 * `prelude_fm_bot` submitting ISRCs to MusicBrainz.
 *
 * The bot only ever posts what a person could have posted from the admin
 * console by clicking a prefilled link. Same detection, same evidence, same
 * ledger — the last step is the only thing that changes. That is deliberate:
 * it means the automation can be switched off and the work continues by hand
 * rather than stopping.
 *
 * Only ISRCs. Releases, works and merges stay human permanently, because a
 * wrong edit there is expensive for other people to undo and that cost is not
 * ours to impose.
 *
 * Credentials are never held here. The token comes from the environment, and
 * without one the bot refuses rather than falling back to anything.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from './db';
import { mbSubmission } from './db/schema';
import { scheduleMusicBrainzRequest } from './musicbrainz-gateway';
import { isrcGaps } from './musicbrainz-contributions';
import {
  buildIsrcSubmission,
  editCount,
  type IsrcSubmissionItem,
} from './musicbrainz-isrc-submission';

const BASE = 'https://musicbrainz.org/ws/2';

/** Identifies the submitting software, which MusicBrainz requires on a POST. */
const CLIENT = 'preludefm-0.1';

const contact = process.env.MUSICBRAINZ_CONTACT ?? 'https://prelude.fm';
const userAgent = `PreludeFM/0.1 ( ${contact} )`;

/**
 * The MusicBrainz bot code of conduct caps a bot at 1,000 edits a day.
 *
 * Counted as edits rather than requests, because one POST can carry fifty
 * ISRCs and each is an edit. The gateway's own bot cap limits requests, which
 * is a different and much weaker constraint.
 */
const DAILY_EDIT_CAP = 1_000;

/** Start far below the cap. It widens once submissions have been reconciled. */
const DEFAULT_BATCH_EDITS = 25;

export class MusicBrainzBotError extends Error {}

export type BotRun = {
  /** What would be, or was, submitted. */
  items: IsrcSubmissionItem[];
  edits: number;
  /** Edits already made today, before this run. */
  spentToday: number;
  submitted: boolean;
  editNote: string;
  payload: string;
};

/**
 * The note attached to every edit.
 *
 * The code of conduct asks that a bot be identifiable, say where its data
 * comes from, and give a way to reach whoever runs it — and that somebody
 * answers when an editor replies.
 */
function editNoteFor(items: IsrcSubmissionItem[]): string {
  return (
    `ISRCs from Spotify, matched to this recording by a release whose barcode is identical ` +
    `and whose track durations agree within 3 seconds. ${items.length} recording(s). ` +
    `Submitted by prelude_fm_bot — ${contact} — replies are read.`
  );
}

/** Edits already made today, from the ledger rather than a counter. */
export async function editsSpentToday(now = new Date()): Promise<number> {
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(mbSubmission)
    .where(
      and(
        eq(mbSubmission.kind, 'isrc'),
        sql`${mbSubmission.submittedBy} like 'bot:%'`,
        gte(mbSubmission.submittedAt, startOfDay),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Submit a batch of ISRCs, or show what would be submitted.
 *
 * `apply` defaults to false and the caller has to ask for a real submission,
 * because the failure mode here is writing to somebody else's database.
 */
export async function runIsrcBot(
  options: { apply?: boolean; maxEdits?: number } = {},
): Promise<BotRun> {
  const maxEdits = options.maxEdits ?? DEFAULT_BATCH_EDITS;
  const spentToday = await editsSpentToday();
  const remaining = Math.max(0, DAILY_EDIT_CAP - spentToday);
  const allowance = Math.min(maxEdits, remaining);

  if (allowance === 0) {
    throw new MusicBrainzBotError(
      `the bot has made ${spentToday} of its ${DAILY_EDIT_CAP} edits today`,
    );
  }

  const gaps = await isrcGaps(allowance);
  const items: IsrcSubmissionItem[] = gaps.map((gap) => ({
    recordingMbid: gap.recordingMbid,
    isrc: gap.isrc,
  }));

  const payload = buildIsrcSubmission(items);
  const edits = editCount(items);
  const editNote = editNoteFor(items);

  if (!options.apply || edits === 0) {
    return { items, edits, spentToday, submitted: false, editNote, payload };
  }

  const token = process.env.MUSICBRAINZ_BOT_TOKEN;
  if (!token) {
    throw new MusicBrainzBotError(
      'MUSICBRAINZ_BOT_TOKEN is not set. The bot needs an OAuth2 bearer token issued ' +
        'to prelude_fm_bot with the submit_isrc scope, from an application registered ' +
        'at https://musicbrainz.org/account/applications with access_type=offline.',
    );
  }

  // Through the gateway like every other request, on the lowest-priority
  // channel: a submission is never more urgent than somebody's import.
  const response = await scheduleMusicBrainzRequest('bot', () =>
    fetch(`${BASE}/recording/?client=${encodeURIComponent(CLIENT)}`, {
      method: 'POST',
      headers: {
        'User-Agent': userAgent,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: payload,
    }),
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new MusicBrainzBotError(
      `MusicBrainz refused the submission: ${response.status} ${body.slice(0, 300)}`,
    );
  }

  // Recorded as pending, not applied. An edit is a proposal that editors vote
  // on; reconciliation marks it applied only once MusicBrainz shows the ISRC.
  for (const gap of gaps) {
    await db
      .insert(mbSubmission)
      .values({
        kind: 'isrc',
        targetMbid: gap.recordingMbid,
        subject: gap.spotifyTrackId,
        value: gap.isrc,
        evidence: {
          releaseMbid: gap.releaseMbid,
          barcode: gap.barcode,
          medium: gap.medium,
          position: gap.position,
          durationDeltaMs: gap.durationDeltaMs,
          matchedBy: gap.matchedBy,
        },
        submittedBy: 'bot:prelude_fm_bot',
        note: editNote,
      })
      .onConflictDoNothing();
  }

  return { items, edits, spentToday, submitted: true, editNote, payload };
}
