import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BotSubmissionResult } from '../app/admin/actions/contribute';
import { LoadFailure } from '../app/admin/components/AdminFailure';
import { afterAdminBurst } from '../app/admin/components/admin-action-queue';
import {
  pendingSummary,
  runAdminAction,
  type AdminActionEffects,
} from '../app/admin/components/useAdminAction';
import {
  botSubmissionFeedback,
  submitThenRefresh,
  type BotSubmissionFeedback,
} from '../app/admin/inbox/bot-submission';

function recordingEffects(events: string[] = [], name = '') {
  const failures: unknown[] = [];
  const prefix = name ? `${name}:` : '';
  const effects: AdminActionEffects = {
    clearFailure: () => events.push(`${prefix}clear`),
    showFailure: (error) => {
      events.push(`${prefix}failure`);
      failures.push(error);
    },
    setStatus: (status) => events.push(`${prefix}${status ?? 'idle'}`),
  };
  return { events, failures, effects };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an admin action clears its last failure, waits its turn, runs, then goes idle', async () => {
  const { events, failures, effects } = recordingEffects();
  await runAdminAction(async () => {
    events.push('action');
  }, effects);
  assert.deepEqual(events, ['clear', 'queued', 'running', 'action', 'idle']);
  assert.deepEqual(failures, []);
});

test('an unqueued admin action runs at once', async () => {
  const { events, effects } = recordingEffects();
  await runAdminAction(
    async () => {
      events.push('action');
    },
    effects,
    { queue: false },
  );
  assert.deepEqual(events, ['clear', 'running', 'action', 'idle']);
});

test('a failed admin action reports the thrown error and still ends its pending state', async () => {
  const { events, failures, effects } = recordingEffects();
  const rejected = new Error('MusicBrainz rejected edit 42');
  await runAdminAction(async () => {
    throw rejected;
  }, effects);
  assert.deepEqual(events, ['clear', 'queued', 'running', 'failure', 'idle']);
  assert.deepEqual(failures, [rejected]);
});

test('two row actions each keep their own pending state and outcome', async () => {
  const events: string[] = [];
  const a = recordingEffects(events, 'a');
  const b = recordingEffects(events, 'b');
  const first = deferred();
  const second = deferred();

  const runA = runAdminAction(() => first.promise, a.effects);
  const runB = runAdminAction(() => second.promise, b.effects);
  await settle();
  // Server actions run one at a time: b waits, and says so.
  assert.deepEqual(events, ['a:clear', 'a:queued', 'a:running', 'b:clear', 'b:queued']);

  first.resolve();
  await settle();
  assert.deepEqual(events.slice(5), ['a:idle', 'b:running']);

  const rejected = new Error('Daily bot edit cap reached');
  second.reject(rejected);
  await Promise.all([runA, runB]);
  assert.deepEqual(events.slice(7), ['b:failure', 'b:idle']);
  assert.deepEqual(a.failures, []);
  assert.deepEqual(b.failures, [rejected]);
});

test("one row's failure survives another row starting", async () => {
  const events: string[] = [];
  const a = recordingEffects(events, 'a');
  const b = recordingEffects(events, 'b');
  await runAdminAction(async () => {
    throw new Error('MusicBrainz refused the submission: 401');
  }, a.effects);
  await runAdminAction(async () => {}, b.effects);
  // Only b cleared its failure; a's is still showing.
  assert.equal(events.filter((event) => event.endsWith(':clear')).join(), 'a:clear,b:clear');
  assert.equal(events.indexOf('a:clear') < events.indexOf('a:failure'), true);
  assert.equal(a.failures.length, 1);
});

test('a burst of actions reloads once, after the last', async () => {
  let reloads = 0;
  const reload = async () => {
    reloads += 1;
  };
  const gate = deferred();
  const runs = [0, 1, 2].map((index) =>
    runAdminAction(async () => {
      if (index === 0) await gate.promise;
      await afterAdminBurst('inbox-reload', reload, () => {});
    }, recordingEffects().effects),
  );
  await settle();
  gate.resolve();
  await Promise.all(runs);
  assert.equal(reloads, 1);
});

test('a reload owed past a failed last action still runs and reports its failure', async () => {
  const reloadFailed = new Error('Inbox reload failed');
  const reported: unknown[] = [];
  const gate = deferred();
  const first = runAdminAction(async () => {
    await gate.promise;
    await afterAdminBurst(
      'inbox-reload',
      async () => {
        throw reloadFailed;
      },
      (error) => reported.push(error),
    );
  }, recordingEffects().effects);
  const last = recordingEffects();
  const second = runAdminAction(async () => {
    throw new Error('rejected');
  }, last.effects);
  await settle();
  gate.resolve();
  await Promise.all([first, second]);
  await settle();
  assert.deepEqual(reported, [reloadFailed]);
});

test('the section header names the running action and how many wait', () => {
  const idle = { label: '', status: null };
  assert.equal(pendingSummary(idle, []), null);
  assert.equal(
    pendingSummary(idle, [
      { label: 'Submitting with prelude_fm_bot…', status: 'running', failure: null },
      { label: 'Submitting with prelude_fm_bot…', status: 'queued', failure: null },
      { label: 'Submitting with prelude_fm_bot…', status: 'queued', failure: null },
      { label: 'Rechecking MusicBrainz…', status: null, failure: 'failed' },
    ]),
    'Submitting with prelude_fm_bot… · 2 more queued',
  );
  assert.equal(
    pendingSummary(idle, [{ label: 'Confirming…', status: 'queued', failure: null }]),
    '1 queued behind other admin actions',
  );
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
