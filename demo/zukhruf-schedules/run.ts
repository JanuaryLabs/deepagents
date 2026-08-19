import { openai } from '@ai-sdk/openai';
import { PGlite } from '@electric-sql/pglite';
import { InMemoryFs } from 'just-bash';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  PollingChangeSource,
  SqliteContextStore,
  SqliteStreamStore,
  StreamManager,
  createVirtualSandbox,
  role,
} from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
} from '@deepagents/experimental/zukhruf';
import {
  scheduleFiles,
  schedules,
} from '@deepagents/experimental/zukhruf/schedules';

await using resources = new AsyncDisposableStack();

const database = resources.adopt(
  new PGlite(join(import.meta.dirname, 'zukhruf.queue')),
  (database) => database.close(),
);
const boss = resources.adopt(
  new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
  (boss) => boss.stop({ graceful: false }),
);
boss.on('error', (error) => console.error('[queue error]', error));
await boss.start();

const queue = new PgBossTurnQueue(boss, {
  pollingIntervalSeconds: 0.5,
  schema: 'pgboss',
});
await queue.initialize();

const streamStore = resources.adopt(
  new SqliteStreamStore(join(import.meta.dirname, 'zukhruf.streams.sqlite')),
  (store) => store.close(),
);
const mailboxStore = resources.use(
  new SqliteMailboxStore(join(import.meta.dirname, 'zukhruf.mailbox.sqlite')),
);
const ownerId = process.env.USER ?? 'local';
const source = scheduleFiles({
  directory: new URL('./agent/schedules/', import.meta.url),
  ownerId,
});
const scheduled = schedules({
  boss,
  queue: 'scheduled-tasks',
  reconciliationIntervalMs: 5_000,
  transaction: (operation) =>
    database.transaction((transaction) => operation(fromPglite(transaction))),
  workerOptions: { pollingIntervalSeconds: 0.5 },
  sources: [source],
});
const runtime = new AgentRuntime(
  defineAgent({
    name: 'scheduled-assistant',
    model: openai('gpt-5.6-luna'),
    sandbox: defineSandbox(() =>
      createVirtualSandbox({ fs: new InMemoryFs(), javascript: true }),
    ),
    instructions: [
      role('Complete scheduled work autonomously and return a concise result.'),
    ],
  }),
  {
    store: new SqliteContextStore(join(import.meta.dirname, 'zukhruf.sqlite')),
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue,
    mailboxStore,
    plugins: [scheduled],
  },
);

await runtime.initialize();
const [task] = await scheduled.list(ownerId);
if (!task) throw new Error('No schedule declarations were found');

console.table([
  {
    name: task.name,
    recurrence: task.recurrence,
    timezone: task.timezone,
    status: task.status,
    nextRunAt: task.nextRunAt ? new Date(task.nextRunAt).toISOString() : null,
  },
]);

if (!process.argv.includes('--list')) {
  resources.use(await runtime.work());

  if (process.argv.includes('--daemon')) {
    console.log('Scheduler running. Press Ctrl+C to stop.');
    const stopped = Promise.withResolvers<void>();
    process.once('SIGINT', () => stopped.resolve());
    process.once('SIGTERM', () => stopped.resolve());
    await stopped.promise;
  } else {
    const launched = await scheduled.runNow(
      ownerId,
      task.id,
      crypto.randomUUID(),
    );
    const deadline = Date.now() + 120_000;
    let run = launched;
    while (run.status === 'dispatching' || run.status === 'running') {
      if (Date.now() >= deadline) throw new Error('Scheduled run timed out');
      await sleep(250);
      run = await scheduled.getRun(ownerId, launched.id);
    }
    if (run.status !== 'completed') {
      throw new Error(run.error ?? `Scheduled run ${run.status}`);
    }

    const messages = await runtime
      .observe({ chatId: run.id, userId: ownerId })
      .engine.getMessages();
    const output = messages
      .at(-1)
      ?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    console.log(`\n${output ?? '(no text output)'}`);
  }
}
