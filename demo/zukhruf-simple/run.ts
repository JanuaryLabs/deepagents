import { PGlite } from '@electric-sql/pglite';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
} from '@deepagents/experimental/zukhruf';

import declaration from './agent.ts';

const database = new PGlite();
const boss = new PgBoss({ db: fromPglite(database), backend: 'pglite' });
boss.on('error', (error) => console.error('[queue error]', error));
await boss.start();

const queue = new PgBossTurnQueue(boss, { schema: 'pgboss' });
await queue.initialize();

const streamStore = new SqliteStreamStore(':memory:');
const streams = new StreamManager({
  store: streamStore,
  changeSource: new PollingChangeSource({ reads: streamStore }),
});
const mailboxStore = new SqliteMailboxStore(':memory:');
const runtime = new AgentRuntime(declaration, {
  store: new InMemoryContextStore(),
  streams,
  queue,
  mailboxStore,
});

try {
  await using worker = await runtime.work();
  void worker;
  const turn = await runtime.enqueue(
    { chatId: crypto.randomUUID(), userId: 'demo' },
    {
      id: crypto.randomUUID(),
      input: process.argv.slice(2).join(' ') || 'Say hello in one sentence.',
    },
  );

  for await (const chunk of turn.stream) {
    if (chunk.type === 'text-delta') process.stdout.write(chunk.delta);
  }
  process.stdout.write('\n');
} finally {
  await boss.stop({ graceful: false });
  await database.close();
  streamStore.close();
  mailboxStore.close();
}
