'use client';

import { useState } from 'react';
import { getBotStatus, type BotStatus, type BotSubmissionResult } from '../actions/contribute';
import type { useAdminAction } from '../components/useAdminAction';
import {
  submitThenRefresh,
  type BotSubmissionFeedback,
  type BotSubmissionMessages,
} from './bot-submission';

/**
 * prelude_fm_bot submissions from one Inbox section, each run as its
 * release's row action. Each outcome stays on its release's row until that
 * row is submitted again or the outcome is dismissed.
 */
export function useBotSubmission({
  runRow,
  onBotChange,
  onReload,
}: {
  runRow: ReturnType<typeof useAdminAction>['runRow'];
  onBotChange: (bot: BotStatus) => void;
  onReload: () => Promise<void>;
}) {
  const [feedback, setFeedback] = useState<Record<string, BotSubmissionFeedback>>({});

  function submit(
    releaseMbid: string,
    submission: (releaseMbid: string) => Promise<BotSubmissionResult>,
    messages: BotSubmissionMessages,
  ) {
    return runRow(releaseMbid, 'Submitting with prelude_fm_bot…', () =>
      submitThenRefresh(() => submission(releaseMbid), messages, {
        show: (next) =>
          setFeedback((current) => {
            const updated = { ...current };
            if (next) updated[releaseMbid] = next;
            else delete updated[releaseMbid];
            return updated;
          }),
        refresh: async () => {
          onBotChange(await getBotStatus());
          await onReload();
        },
      }),
    );
  }

  function dismiss(releaseMbid: string) {
    setFeedback((current) => {
      const updated = { ...current };
      delete updated[releaseMbid];
      return updated;
    });
  }

  return { feedback, submit, dismiss };
}
