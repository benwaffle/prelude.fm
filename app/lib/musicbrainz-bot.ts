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
 * Credentials are never held here. The refresh token comes from the
 * environment and is exchanged for a short-lived access token on demand;
 * without one the bot refuses rather than falling back to anything.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from './db';
import { mbSubmission } from './db/schema';
import { scheduleMusicBrainzRequest } from './musicbrainz-gateway';
import { isrcGaps } from './musicbrainz-contributions';
import type { IsrcGap } from './musicbrainz-edit-links';
import {
  buildIsrcSubmission,
  editCount,
  editNoteFor,
  type IsrcSubmissionItem,
} from './musicbrainz-isrc-submission';
import { botAccessToken } from './musicbrainz-oauth';

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

/**
 * A ceiling on one album, not a batch size.
 *
 * Submissions are made an album at a time, because an album is the unit a
 * person can actually check: same release, same barcode, one tracklist to
 * read down. This only stops a box set with hundreds of missing ISRCs from
 * spending most of the day's allowance in one press.
 */
const MAX_EDITS_PER_ALBUM = 200;

export class MusicBrainzBotError extends Error {}

export type BotRun = {
  /** The release this batch belongs to; every item is from it. */
  releaseMbid: string | null;
  albumTitle: string | null;
  /** What would be, or was, submitted. */
  items: IsrcSubmissionItem[];
  /**
   * The evidence behind each item.
   *
   * Carried through rather than summarised, because the point of showing a
   * batch before it goes is that somebody can check it — and an ISRC and an
   * MBID alone are two opaque strings. The titles say what is being claimed
   * about what, and the two barcodes let the match be seen rather than
   * trusted.
   */
  evidence: IsrcGap[];
  edits: number;
  /** Edits already made today, before this run. */
  spentToday: number;
  submitted: boolean;
  editNote: string;
  payload: string;
};

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
  options: { apply?: boolean; maxEdits?: number; releaseMbid?: string } = {},
): Promise<BotRun> {
  const maxEdits = options.maxEdits ?? MAX_EDITS_PER_ALBUM;
  const spentToday = await editsSpentToday();
  const remaining = Math.max(0, DAILY_EDIT_CAP - spentToday);
  const allowance = Math.min(maxEdits, remaining);

  if (allowance === 0) {
    throw new MusicBrainzBotError(
      `the bot has made ${spentToday} of its ${DAILY_EDIT_CAP} edits today`,
    );
  }

  /*
   * One album. Which one is the caller's choice rather than the bot's,
   * because the person pressing the button is the one who has read it — and
   * a bot that picks its own target would be deciding what to submit, which
   * is the part that has not been earned yet.
   */
  const everything = await isrcGaps(5_000);
  const releaseMbid = options.releaseMbid ?? everything[0]?.releaseMbid;
  const gaps = everything.filter((gap) => gap.releaseMbid === releaseMbid).slice(0, allowance);
  const items: IsrcSubmissionItem[] = gaps.map((gap) => ({
    recordingMbid: gap.recordingMbid,
    isrc: gap.isrc,
  }));

  const payload = buildIsrcSubmission(items);
  const edits = editCount(items);
  const editNote = editNoteFor(gaps);

  if (!options.apply || edits === 0) {
    return {
      releaseMbid: releaseMbid ?? null,
      albumTitle: gaps[0]?.albumTitle ?? null,
      items,
      evidence: gaps,
      edits,
      spentToday,
      submitted: false,
      editNote,
      payload,
    };
  }

  // Exchanged from the refresh token on demand, because access tokens expire
  // and a stored one would start failing an hour after it was written down.
  const token = await botAccessToken();

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

  return {
    releaseMbid: releaseMbid ?? null,
    albumTitle: gaps[0]?.albumTitle ?? null,
    items,
    evidence: gaps,
    edits,
    spentToday,
    submitted: true,
    editNote,
    payload,
  };
}
