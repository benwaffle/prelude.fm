// Next.js already serialises server actions; queueing here too lets a row say honestly whether it
// is queued or running.

type Task = { start: () => void; work: () => Promise<void>; done: () => void };
type Owed = { work: () => Promise<void>; onError: (error: unknown) => void };

const tasks: Task[] = [];
const owed = new Map<string, Owed>();
let draining = false;

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

// With actions still queued, follow-up work runs once per `key` when the queue drains; otherwise it
// runs now.
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
