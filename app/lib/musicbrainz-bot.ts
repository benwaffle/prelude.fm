// Posts only what a person could post from the admin console: same detection, evidence and ledger.
// Only ISRCs and barcodes; releases, works and merges stay human.
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

/** MusicBrainz requires a client identifier on a POST. */
const CLIENT = 'preludefm-0.1';

const userAgent = `PreludeFM/0.1 ( ${BOT_CONTACT} )`;

/** The bot code of conduct caps a bot at 1,000 edits a day; one POST can carry many edits. */
export const DAILY_EDIT_CAP = 1_000;

const BOT_SUBMITTER = 'bot:prelude_fm_bot';

// A ceiling on one album, not a batch size: stops a box set spending most of the day's allowance.
const MAX_ISRC_EDITS_PER_ALBUM = 200;

const MAX_BARCODE_EDITS_PER_BATCH = 50;

export class MusicBrainzBotError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
  }
}

export type BotRun<Gap, Item> = {
  items: Item[];
  // Carried through rather than summarised so a reviewer can check the claim, not just two opaque
  // IDs.
  evidence: Gap[];
  edits: number;
  spentToday: number;
  submitted: boolean;
  editNote: string;
  payload: string;
};

export type IsrcBotRun = BotRun<IsrcGap, IsrcSubmissionItem> & {
  releaseMbid: string | null;
  albumTitle: string | null;
};

export type BarcodeBotRun = BotRun<BarcodeGap, BarcodeSubmissionItem>;

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

/** `apply` defaults to false: the failure mode is writing to somebody else's database. */
async function runBot<Gap, Item>(
  options: { apply?: boolean; maxEdits: number },
  kind: {
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

export async function runIsrcBot(
  options: {
    apply?: boolean;
    maxEdits?: number;
    releaseMbid?: string;
    /** Send this one ISRC even though voters rejected it before; a batch never includes it. */
    resubmit?: { recordingMbid: string; isrc: string };
  } = {},
): Promise<IsrcBotRun> {
  // The caller picks the album, not the bot: choosing what to submit has not been earned yet.
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

export async function runBarcodeBot(
  options: { apply?: boolean; maxEdits?: number; releaseMbid?: string } = {},
): Promise<BarcodeBotRun> {
  const releaseMbid = options.releaseMbid;
  return runBot(
    { apply: options.apply, maxEdits: options.maxEdits ?? MAX_BARCODE_EDITS_PER_BATCH },
    {
      // A named release is its row's own click, so a previously rejected barcode may go again; a
      // batch leaves those out.
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
