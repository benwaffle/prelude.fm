/**
 * `prelude_fm_bot` submitting ISRCs and barcodes to MusicBrainz.
 *
 * The bot only ever posts what a person could have posted from the admin
 * console by clicking a prefilled link or confirming a ledger row. Same
 * detection, same evidence, same ledger — the last step is the only thing
 * that changes. That is deliberate: it means the automation can be switched
 * off and the work continues by hand rather than stopping.
 *
 * Only ISRCs and barcodes. Releases, works and merges stay human permanently,
 * because a wrong edit there is expensive for other people to undo and that
 * cost is not ours to impose.
 *
 * Credentials are never held here. The refresh token comes from the
 * environment and is exchanged for a short-lived access token on demand;
 * without one the bot refuses rather than falling back to anything.
 */
import { and, gte, inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { mbSubmission } from './db/schema';
import { barcodeEligibleGaps, type BarcodeGap } from './gaps/barcodes';
import { isrcBatchGaps, isrcEligibleGaps } from './gaps/isrc';
import { normalizeIsrc } from './isrc';
import { scheduleMusicBrainzRequest } from './musicbrainz-gateway';
import type { IsrcGap } from './musicbrainz-edit-links';
import {
  buildBarcodeSubmission,
  editCount as barcodeEditCount,
  editNoteFor as barcodeEditNoteFor,
  type BarcodeSubmissionItem,
} from './musicbrainz-barcode-submission';
import {
  buildIsrcSubmission,
  editCount as isrcEditCount,
  editNoteFor as isrcEditNoteFor,
  type IsrcSubmissionItem,
} from './musicbrainz-isrc-submission';
import { barcodeSubmissionDraft, isrcSubmissionDraft } from './musicbrainz-manual-submissions';
import { botAccessToken } from './musicbrainz-oauth';
import { BOT_CONTACT } from './musicbrainz-xml';
import type { SubmissionDraft } from './submission-evidence';
import { insertSubmissions } from './submission-ledger';

const BASE = 'https://musicbrainz.org/ws/2';
const MAX_ERROR_BODY = 4096;

function rejectedBody(body: string): string {
  return body.length > MAX_ERROR_BODY
    ? `${body.slice(0, MAX_ERROR_BODY)}\n[response truncated after ${MAX_ERROR_BODY} characters]`
    : body;
}

/** Identifies the submitting software, which MusicBrainz requires on a POST. */
const CLIENT = 'preludefm-0.1';

const userAgent = `PreludeFM/0.1 ( ${BOT_CONTACT} )`;

/**
 * The MusicBrainz bot code of conduct caps a bot at 1,000 edits a day.
 *
 * Counted as edits rather than requests, because one POST can carry many
 * ISRCs and each is an edit. The gateway's own bot cap limits requests, which
 * is a different and much weaker constraint.
 */
export const DAILY_EDIT_CAP = 1_000;

const BOT_SUBMITTER = 'bot:prelude_fm_bot';

/**
 * A ceiling on one album, not a batch size.
 *
 * Submissions are made an album at a time, because an album is the unit a
 * person can actually check: same release, same barcode, one tracklist to
 * read down. This only stops a box set with hundreds of missing ISRCs from
 * spending most of the day's allowance in one press.
 */
const MAX_ISRC_EDITS_PER_ALBUM = 200;

/** Barcode batches stay smaller — each release is a separate edit to review. */
const MAX_BARCODE_EDITS_PER_BATCH = 50;

export class MusicBrainzBotError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** One batch, as shown before it is sent and as recorded after. */
export type BotRun<Gap, Item> = {
  /** What would be, or was, submitted. */
  items: Item[];
  /**
   * The evidence behind each item.
   *
   * Carried through rather than summarised, because the point of showing a
   * batch before it goes is that somebody can check it — and an ISRC and an
   * MBID alone are two opaque strings. The titles say what is being claimed
   * about what, and the two barcodes let the match be seen rather than
   * trusted.
   */
  evidence: Gap[];
  edits: number;
  /** Edits already made today, before this run. */
  spentToday: number;
  submitted: boolean;
  editNote: string;
  payload: string;
};

export type IsrcBotRun = BotRun<IsrcGap, IsrcSubmissionItem> & {
  /** The release this batch belongs to; every item is from it. */
  releaseMbid: string | null;
  albumTitle: string | null;
};

export type BarcodeBotRun = BotRun<BarcodeGap, BarcodeSubmissionItem>;

/** Edits already made today, from the ledger rather than a counter. */
export async function editsSpentToday(now = new Date()): Promise<number> {
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(mbSubmission)
    .where(
      and(
        inArray(mbSubmission.kind, ['isrc', 'barcode']),
        sql`${mbSubmission.submittedBy} like 'bot:%'`,
        gte(mbSubmission.submittedAt, startOfDay),
      ),
    );
  return row?.n ?? 0;
}

/** POST one document; a refusal is an error carrying MusicBrainz's status and reply. */
async function postBotEdits(path: 'recording' | 'release', payload: string): Promise<void> {
  const token = await botAccessToken();

  const response = await scheduleMusicBrainzRequest('bot', () =>
    fetch(`${BASE}/${path}/?client=${encodeURIComponent(CLIENT)}`, {
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
      `MusicBrainz refused the submission: ${response.status} ${rejectedBody(body)}`,
      response.status,
    );
  }
}

/**
 * One bot batch: check today's allowance, pick the gaps, build the document,
 * and — only when asked — send it and record what was accepted.
 *
 * `apply` defaults to false and the caller has to ask for a real submission,
 * because the failure mode here is writing to somebody else's database.
 */
async function runBot<Gap, Item>(
  options: { apply?: boolean; maxEdits: number },
  kind: {
    /** The batch, at most `allowance` edits. */
    gaps: (allowance: number) => Promise<Gap[]>;
    toItem: (gap: Gap) => Item;
    editCount: (items: Item[]) => number;
    editNote: (gaps: Gap[]) => string;
    build: (items: Item[], editNote: string) => string;
    toDraft: (gap: Gap) => SubmissionDraft;
    path: 'recording' | 'release';
  },
): Promise<BotRun<Gap, Item>> {
  const spentToday = await editsSpentToday();
  const remaining = Math.max(0, DAILY_EDIT_CAP - spentToday);
  const allowance = Math.min(options.maxEdits, remaining);

  if (allowance === 0) {
    throw new MusicBrainzBotError(
      `the bot has made ${spentToday} of its ${DAILY_EDIT_CAP} edits today`,
    );
  }

  const gaps = await kind.gaps(allowance);
  const items = gaps.map(kind.toItem);
  const edits = kind.editCount(items);
  const editNote = kind.editNote(gaps);
  const payload = kind.build(items, editNote);
  const run = { items, evidence: gaps, edits, spentToday, submitted: false, editNote, payload };

  if (!options.apply || edits === 0) return run;

  await postBotEdits(kind.path, payload);
  // MusicBrainz has the edits now; the daily cap is counted from these rows.
  await insertSubmissions(gaps.map(kind.toDraft), { submittedBy: BOT_SUBMITTER, note: editNote });
  return { ...run, submitted: true };
}

/** Submit a batch of ISRCs, or show what would be submitted. */
export async function runIsrcBot(
  options: {
    apply?: boolean;
    maxEdits?: number;
    releaseMbid?: string;
    /**
     * Send this one ISRC, even though voters rejected it before. The batch
     * never includes a rejected ISRC; only its own row's click does.
     */
    resubmit?: { recordingMbid: string; isrc: string };
  } = {},
): Promise<IsrcBotRun> {
  /*
   * One album. Which one is the caller's choice rather than the bot's,
   * because the person pressing the button is the one who has read it — and
   * a bot that picks its own target would be deciding what to submit, which
   * is the part that has not been earned yet.
   */
  let releaseMbid = options.releaseMbid;
  const run = await runBot(
    { apply: options.apply, maxEdits: options.maxEdits ?? MAX_ISRC_EDITS_PER_ALBUM },
    {
      gaps: async (allowance) => {
        const scope = releaseMbid ? { releaseMbids: [releaseMbid] } : {};
        const resubmit = options.resubmit;
        const everything = resubmit
          ? (await isrcEligibleGaps(scope)).filter(
              (gap) =>
                gap.recordingMbid === resubmit.recordingMbid &&
                normalizeIsrc(gap.isrc) === normalizeIsrc(resubmit.isrc),
            )
          : await isrcBatchGaps(scope);
        releaseMbid ??= everything[0]?.releaseMbid;
        return everything.filter((gap) => gap.releaseMbid === releaseMbid).slice(0, allowance);
      },
      toItem: (gap) => ({ recordingMbid: gap.recordingMbid, isrc: gap.isrc }),
      editCount: isrcEditCount,
      editNote: isrcEditNoteFor,
      build: buildIsrcSubmission,
      toDraft: isrcSubmissionDraft,
      path: 'recording',
    },
  );
  return {
    ...run,
    releaseMbid: releaseMbid ?? null,
    albumTitle: run.evidence[0]?.albumTitle ?? null,
  };
}

/**
 * Submit one or more release barcodes, or show what would be submitted.
 *
 * Each gap is a release we already matched by title and duration with
 * Spotify's exact UPC — the same evidence as the Inbox barcode section.
 */
export async function runBarcodeBot(
  options: { apply?: boolean; maxEdits?: number; releaseMbid?: string } = {},
): Promise<BarcodeBotRun> {
  const releaseMbid = options.releaseMbid;
  return runBot(
    { apply: options.apply, maxEdits: options.maxEdits ?? MAX_BARCODE_EDITS_PER_BATCH },
    {
      // A named release is its row's own click, so a barcode rejected before
      // may go again; an unnamed batch leaves rejected ones out.
      gaps: async (allowance) =>
        releaseMbid
          ? (await barcodeEligibleGaps({ releaseMbids: [releaseMbid] })).slice(0, 1)
          : (await barcodeEligibleGaps({ batch: true })).slice(0, allowance),
      toItem: (gap) => ({ releaseMbid: gap.releaseMbid, barcode: gap.barcode }),
      editCount: barcodeEditCount,
      editNote: barcodeEditNoteFor,
      build: buildBarcodeSubmission,
      toDraft: barcodeSubmissionDraft,
      path: 'release',
    },
  );
}
