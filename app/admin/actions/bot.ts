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

// Dry run kept separate from submit on purpose: each batch is reviewed (evidence, note, payload)
// before it is sent.
export type BotStatus = {
  configured: boolean;
  spentToday: number;
  dailyCap: number;
};

export async function getBotStatus(): Promise<BotStatus> {
  await checkAuth();
  return {
    configured: botCredentials() !== null,
    spentToday: await editsSpentToday(),
    dailyCap: DAILY_EDIT_CAP,
  };
}

export async function getBotPayload(releaseMbid: string): Promise<string> {
  await checkAuth();
  const run = await runIsrcBot({ apply: false, releaseMbid });
  return run.payload;
}

export async function getBarcodeBotPayload(releaseMbid: string): Promise<string> {
  await checkAuth();
  const run = await runBarcodeBot({ apply: false, releaseMbid });
  return run.payload;
}

export type IsrcResubmission = { recordingMbid: string; isrc: string };

export type BotSubmissionResult =
  | { ok: true; submitted: number; title: string | null }
  | { ok: false; status: number | null; detail: string };

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
