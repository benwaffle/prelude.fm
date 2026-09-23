import type { BotSubmissionResult } from '../actions/contribute';
import { adminFailureMessage } from '../components/AdminFailure';

export type BotSubmissionFeedback =
  | { kind: 'success' | 'empty'; message: string }
  | { kind: 'error'; message: string; httpStatus: number | null };

export type BotSubmissionMessages = { success: (submitted: number) => string; empty: string };

/**
 * What a row says about its latest bot submission. A call that never
 * answered is "not confirmed", never a MusicBrainz rejection, and a batch with
 * nothing eligible is neither success nor rejection.
 */
export async function botSubmissionFeedback(
  submit: () => Promise<BotSubmissionResult>,
  messages: BotSubmissionMessages,
): Promise<BotSubmissionFeedback> {
  let result: BotSubmissionResult;
  try {
    result = await submit();
  } catch (error) {
    return {
      kind: 'error',
      message: `Submission status could not be confirmed: ${adminFailureMessage(error)}`,
      httpStatus: null,
    };
  }
  if (!result.ok) return { kind: 'error', message: result.detail, httpStatus: result.status };
  if (result.submitted === 0) return { kind: 'empty', message: messages.empty };
  return { kind: 'success', message: messages.success(result.submitted) };
}

/**
 * Submit, put the outcome on the row, and refresh only after an accepted
 * edit. Only `refresh` can throw: its failure is the admin action's failure
 * and leaves the row's outcome in place.
 */
export async function submitThenRefresh(
  submit: () => Promise<BotSubmissionResult>,
  messages: BotSubmissionMessages,
  row: { show: (feedback: BotSubmissionFeedback | null) => void; refresh: () => Promise<void> },
): Promise<void> {
  row.show(null);
  const outcome = await botSubmissionFeedback(submit, messages);
  row.show(outcome);
  if (outcome.kind === 'success') await row.refresh();
}
