import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BotSubmissionResult } from '../app/admin/actions/contribute';
import { LoadFailure } from '../app/admin/components/AdminFailure';
import { runAdminAction, type AdminActionEffects } from '../app/admin/components/useAdminAction';
import {
  botSubmissionFeedback,
  submitThenRefresh,
  type BotSubmissionFeedback,
} from '../app/admin/inbox/bot-submission';

function recordingEffects() {
  const events: string[] = [];
  const failures: unknown[] = [];
  const effects: AdminActionEffects = {
    clearFailure: () => events.push('clear'),
    showFailure: (error) => {
      events.push('failure');
      failures.push(error);
    },
    setPending: (label) => events.push(`pending:${label}`),
  };
  return { events, failures, effects };
}

test('an admin action clears the last failure, shows progress, then clears progress', async () => {
  const { events, failures, effects } = recordingEffects();
  await runAdminAction(
    'Rechecking MusicBrainz…',
    async () => {
      events.push('action');
    },
    effects,
  );
  assert.deepEqual(events, ['clear', 'pending:Rechecking MusicBrainz…', 'action', 'pending:null']);
  assert.deepEqual(failures, []);
});

test('a failed admin action reports the thrown error and still ends its pending state', async () => {
  const { events, failures, effects } = recordingEffects();
  const rejected = new Error('MusicBrainz rejected edit 42');
  await runAdminAction(
    'Confirming submission…',
    async () => {
      throw rejected;
    },
    effects,
  );
  assert.deepEqual(events, ['clear', 'pending:Confirming submission…', 'failure', 'pending:null']);
  assert.deepEqual(failures, [rejected]);
});

const messages = {
  success: (submitted: number) => `submitted ${submitted} ISRCs`,
  empty: 'No eligible ISRC was found for this release.',
};

test('bot outcomes keep rejection, unconfirmed and nothing-eligible distinct', async () => {
  assert.deepEqual(
    await botSubmissionFeedback(
      async () => ({ ok: false, status: 401, detail: 'MusicBrainz refused the submission: 401' }),
      messages,
    ),
    { kind: 'error', message: 'MusicBrainz refused the submission: 401', httpStatus: 401 },
  );
  assert.deepEqual(
    await botSubmissionFeedback(async () => {
      throw new Error('fetch failed');
    }, messages),
    {
      kind: 'error',
      message: 'Submission status could not be confirmed: fetch failed',
      httpStatus: null,
    },
  );
  assert.deepEqual(
    await botSubmissionFeedback(async () => ({ ok: true, submitted: 0, title: null }), messages),
    { kind: 'empty', message: messages.empty },
  );
  assert.deepEqual(
    await botSubmissionFeedback(async () => ({ ok: true, submitted: 3, title: null }), messages),
    { kind: 'success', message: 'submitted 3 ISRCs' },
  );
});

async function submitThroughAction(result: BotSubmissionResult, refresh: () => Promise<void>) {
  const { failures, effects } = recordingEffects();
  const shown: (BotSubmissionFeedback | null)[] = [];
  let refreshed = 0;
  await runAdminAction(
    'Submitting with prelude_fm_bot…',
    () =>
      submitThenRefresh(async () => result, messages, {
        show: (feedback) => shown.push(feedback),
        refresh: async () => {
          refreshed += 1;
          await refresh();
        },
      }),
    effects,
  );
  return { failures, shown, refreshed };
}

test('an accepted edit stays on its row when the refresh after it fails', async () => {
  const reloadFailed = new Error('Inbox reload failed');
  const { failures, shown, refreshed } = await submitThroughAction(
    { ok: true, submitted: 2, title: 'Brahms' },
    async () => {
      throw reloadFailed;
    },
  );
  assert.deepEqual(shown, [null, { kind: 'success', message: 'submitted 2 ISRCs' }]);
  assert.equal(refreshed, 1);
  assert.deepEqual(failures, [reloadFailed]);
});

test('a rejected edit is reported on its row only, with nothing to refresh', async () => {
  const { failures, shown, refreshed } = await submitThroughAction(
    { ok: false, status: 401, detail: 'MusicBrainz refused the submission: 401' },
    async () => {},
  );
  assert.equal(shown.at(-1)?.kind, 'error');
  assert.equal(refreshed, 0);
  assert.deepEqual(failures, []);
});

test('a load failure is shown in place with its message and a retry', () => {
  const html = renderToStaticMarkup(
    <LoadFailure what="the Inbox" error="Turso timed out" onRetry={() => {}} />,
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not load the Inbox: Turso timed out/);
  assert.match(html, /Retry/);
});
