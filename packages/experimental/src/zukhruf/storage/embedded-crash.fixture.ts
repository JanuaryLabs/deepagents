/**
 * Process the embedded-storage tests open the storage in. It opens the
 * storage in argv[2] and acts as argv[3] names:
 * - `open`: prints the name and message of the open's error, or `opened`,
 *   then disposes the storage and exits.
 *
 * Every other name stops at that point, prints the name, and waits to be
 * SIGKILLed:
 * - `opened`: the storage is open; nothing else happened.
 * - `committed`: it admitted one child turn; the admission committed and its turn waits in the outbox;
 *   pg-boss never received it.
 * - `pushed`: pg-boss holds the turn's job and its outbox row is still there.
 */
import { open } from '@zukhruf/sqlite-open';
import { join } from 'node:path';
import { z } from 'zod';

import {
  EmbeddedAgentStorage,
  EmbeddedAgentStorageInUseError,
} from '@deepagents/experimental/zukhruf';

const [directory, stop] = process.argv.slice(2);
const stops = ['open', 'opened', 'committed', 'pushed'];
if (!directory || !stop || !stops.includes(stop)) {
  throw new Error(
    `usage: embedded-crash.fixture.ts <directory> ${stops.join('|')}`,
  );
}

if (stop === 'open') {
  try {
    await using _storage = await EmbeddedAgentStorage.open({ directory });
    console.log('opened');
  } catch (error) {
    if (!(error instanceof EmbeddedAgentStorageInUseError)) throw error;
    console.log(`${error.name}: ${error.message}`);
  }
  process.exit(0);
}

const storage = await EmbeddedAgentStorage.open({ directory });
if (stop === 'opened') await waitToBeKilled(stop);
const child = { chatId: 'child', userId: 'user-1' };

// Platform setup no storage operation exposes: an open PGlite transaction
// holds pg-boss's database, so the relay's push waits behind it.
const queueHeld = Promise.withResolvers<void>();
const queueReleased = Promise.withResolvers<void>();
void storage.queueDatabase.transaction(async () => {
  queueHeld.resolve();
  await queueReleased.promise;
});
await queueHeld.promise;

await storage.admit({ userId: 'user-1', treeId: 'root' }, async (scope) => {
  // The test expects this exact turn back from the reopened storage.
  await scope.queue.push({
    kind: 'message',
    streamId: 'turn/child#1',
    ...child,
    message: {
      id: 'child-task',
      role: 'user',
      parts: [{ type: 'text', text: 'new task' }],
    },
    trigger: 'submit-message',
    elements: [],
  });
});

if (stop === 'pushed') {
  // Platform setup no storage operation exposes: a second connection holds
  // SQLite's write lock, so the relay's delete after the push fails.
  const writer = open(join(directory, 'zukhruf.sqlite'), { timeout: 0 });
  writer.exec('BEGIN IMMEDIATE');
  queueReleased.resolve();
  const queue = 'zukhruf-turns';
  for (;;) {
    const jobs = await storage.boss.findJobs(queue, { key: child.chatId });
    if (jobs.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The held write lock refuses the relay's delete, so the row must still be there.
  const { rows } = z
    .object({ rows: z.number() })
    .parse(
      writer.prepare('SELECT count(*) AS rows FROM zukhruf_turn_outbox').get(),
    );
  if (rows !== 1)
    throw new Error(
      `expected the outbox row to survive the push, found ${rows}`,
    );
}

await waitToBeKilled(stop);

/** Prints `point`, then never resolves: the test SIGKILLs this process, and it exits if the test died first. */
async function waitToBeKilled(point: string): Promise<never> {
  console.log(point);
  const ownerPid = process.ppid;
  setInterval(() => {
    if (process.ppid !== ownerPid) process.exit(0);
  }, 100);
  return new Promise<never>(() => undefined);
}
