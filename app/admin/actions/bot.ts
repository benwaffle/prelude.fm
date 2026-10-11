'use server';

import {
  DAILY_EDIT_CAP,
  editsSpentToday,
  MusicBrainzBotError,
  runBarcodeBot,
  runIsrcBot,
} from '@/lib/musicbrainz-bot';
import { botCredentials } from '@/lib/musicbrainz-oauth';
import { checkAuth } from './auth';

/**
 * What the bot would submit, without submitting it.
 *
 * Separate from the submit action on purpose. Every batch is looked at
 * before it is sent: the evidence is shown, the edit note is shown, and the
 * payload is available to read. Automation is something each class of edit
 * earns, and for now the earning is somebody deciding one batch at a time.
 */
export type BotStatus = {
  configured: boolean;
  spentToday: number;
  dailyCap: number;
};

/** Whether the bot can submit, and how much of today's allowance is left. */
export async function getBotStatus(): Promise<BotStatus> {
  await checkAuth();
  return {
    configured: botCredentials() !== null,
    spentToday: await editsSpentToday(),
    dailyCap: DAILY_EDIT_CAP,
  };
}

/**
 * The exact document that would be sent for one release.
 *
 * Kept available because "show me what you would actually post" is the last
 * check before trusting a machine with somebody else's database, and a
 * summary is not that.
 */
export async function getBotPayload(releaseMbid: string): Promise<string> {
  await checkAuth();
  const run = await runIsrcBot({ apply: false, releaseMbid });
  return run.payload;
}

/** The exact barcode document that would be sent for one release. */
export async function getBarcodeBotPayload(releaseMbid: string): Promise<string> {
  await checkAuth();
  const run = await runBarcodeBot({ apply: false, releaseMbid });
  return run.payload;
}

/** One ISRC voters rejected before, one track at a time. */
export type IsrcResubmission = { recordingMbid: string; isrc: string };

export type BotSubmissionResult =
  | { ok: true; submitted: number; title: string | null }
  | { ok: false; status: number | null; detail: string };

/** Run a submission, turning a refusal into a result the row can show. */
async function botSubmission(
  submit: () => Promise<{ edits: number; title: string | null }>,
): Promise<BotSubmissionResult> {
  try {
    const run = await submit();
    return { ok: true, submitted: run.edits, title: run.title };
  } catch (error) {
    return {
      ok: false,
      status: error instanceof MusicBrainzBotError ? error.status : null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function submitBotBatch(
  releaseMbid: string,
  resubmit?: IsrcResubmission,
): Promise<BotSubmissionResult> {
  await checkAuth();
  return botSubmission(async () => {
    const run = await runIsrcBot({ apply: true, releaseMbid, resubmit });
    return { edits: run.edits, title: run.albumTitle };
  });
}

export async function submitBarcodeBotBatch(releaseMbid: string): Promise<BotSubmissionResult> {
  await checkAuth();
  return botSubmission(async () => {
    const run = await runBarcodeBot({ apply: true, releaseMbid });
    return { edits: run.edits, title: run.evidence[0]?.releaseTitle ?? null };
  });
}
