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
 * prelude_fm_bot submissions from one Inbox section, run as that section's
 * admin actions. Each outcome stays on its release's row.
 */
export function useBotSubmission({
  run,
  onBotChange,
  onReload,
}: {
  run: ReturnType<typeof useAdminAction>['run'];
  onBotChange: (bot: BotStatus) => void;
  onReload: () => Promise<void>;
}) {
  const [feedback, setFeedback] = useState<Record<string, BotSubmissionFeedback>>({});

  function submit(
    releaseMbid: string,
    submission: (releaseMbid: string) => Promise<BotSubmissionResult>,
    messages: BotSubmissionMessages,
  ) {
    return run('Submitting with prelude_fm_bot…', () =>
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

  return { feedback, submit };
}
