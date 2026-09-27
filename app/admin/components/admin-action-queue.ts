/**
 * The admin's actions, run one at a time in click order.
 *
 * Next.js dispatches a client's server actions one at a time anyway (its
 * router action queue), and the MusicBrainz gateway sends bot edits at
 * 1/sec. Queueing here as well lets a row say honestly whether its action is
 * still waiting ("queued") or is the one running, instead of every row
 * claiming to submit at once.
 */

type Task = { start: () => void; work: () => Promise<void>; done: () => void };
type Owed = { work: () => Promise<void>; onError: (error: unknown) => void };

const tasks: Task[] = [];
const owed = new Map<string, Owed>();
let draining = false;

/** Queue `work`; `start` fires when its turn comes. Resolves when it has run. */
export function enqueueAdminAction(start: () => void, work: () => Promise<void>): Promise<void> {
  return new Promise((done) => {
    tasks.push({ start, work, done });
    void drain();
  });
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (tasks.length > 0 || owed.size > 0) {
      const task = tasks.shift();
      if (task) {
        task.start();
        try {
          await task.work();
        } catch {
          // Callers report their own failures; one must not stall the rest.
        } finally {
          task.done();
        }
        continue;
      }
      const [key, entry] = owed.entries().next().value as [string, Owed];
      owed.delete(key);
      try {
        await entry.work();
      } catch (error) {
        entry.onError(error);
      }
    }
  } finally {
    draining = false;
  }
}

/** Actions waiting behind the one running now. */
export function queuedAdminActions(): number {
  return tasks.length;
}

/**
 * Follow-up work, such as reloading the Inbox, that only the last action of
 * a burst needs. With actions still queued it is owed, once per `key`, and
 * runs when the queue drains, reporting any failure to `onError`. Otherwise
 * it runs now and its failure is the caller's.
 */
export async function afterAdminBurst(
  key: string,
  work: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  if (tasks.length > 0) {
    owed.set(key, { work, onError });
    return;
  }
  owed.delete(key);
  await work();
}
