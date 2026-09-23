'use client';

import { useState, type Dispatch, type SetStateAction } from 'react';
import { getBotStatus, type BotStatus, type BotSubmissionResult } from '../actions/contribute';
import type { BotSubmissionFeedback } from './BotSubmissionNotice';

export function useBotSubmission({
  clearFailure,
  showFailure,
  setPending,
  onBotChange,
  onReload,
}: {
  clearFailure: () => void;
  showFailure: (error: unknown) => void;
  setPending: Dispatch<SetStateAction<string | null>>;
  onBotChange: (bot: BotStatus) => void;
  onReload: () => Promise<void>;
}) {
  const [feedback, setFeedback] = useState<Record<string, BotSubmissionFeedback>>({});

  async function submit(
    releaseMbid: string,
    action: (releaseMbid: string) => Promise<BotSubmissionResult>,
    successMessage: (submitted: number) => string,
    emptyMessage: string,
  ) {
    clearFailure();
    setFeedback((current) => {
      const next = { ...current };
      delete next[releaseMbid];
      return next;
    });
    setPending('Submitting with prelude_fm_bot…');
    let accepted = false;
    try {
      const result = await action(releaseMbid);
      if (!result.ok) {
        setFeedback((current) => ({
          ...current,
          [releaseMbid]: {
            kind: 'error',
            message: result.detail,
            httpStatus: result.status,
          },
        }));
        return;
      }
      if (result.submitted === 0) {
        setFeedback((current) => ({
          ...current,
          [releaseMbid]: { kind: 'empty', message: emptyMessage },
        }));
        return;
      }

      accepted = true;
      setFeedback((current) => ({
        ...current,
        [releaseMbid]: { kind: 'success', message: successMessage(result.submitted) },
      }));
      onBotChange(await getBotStatus());
      await onReload();
    } catch (error) {
      if (accepted) {
        // A later status/reload failure does not change MusicBrainz's acceptance.
        showFailure(error);
      } else {
        setFeedback((current) => ({
          ...current,
          [releaseMbid]: {
            kind: 'error',
            message: `Submission status could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
          },
        }));
      }
    } finally {
      setPending(null);
    }
  }

  return { feedback, submit };
}
