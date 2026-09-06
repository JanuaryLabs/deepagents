import { PGlite } from '@electric-sql/pglite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  renderTurn,
} from '@deepagents/experimental/zukhruf';

import root from './agent.ts';

mkdirSync(join(import.meta.dirname, 'workspace'), { recursive: true });
mkdirSync(join(import.meta.dirname, 'skills'), { recursive: true });

const input = process.argv.slice(2).join(' ').trim();
if (!input) {
  throw new Error('Usage: node --env-file=.env run.ts "Describe the task"');
}

await using resources = new AsyncDisposableStack();
const database = resources.adopt(new PGlite(), (database) => database.close());
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
  new SqliteStreamStore(':memory:'),
  (store) => store.close(),
);
const runtime = new AgentRuntime(root, {
  store: new InMemoryContextStore(),
  streams: new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  }),
  queue,
  mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
});
resources.use(await runtime.work({ concurrency: 4 }));

const turn = await runtime.enqueue(
  { chatId: crypto.randomUUID(), userId: 'demo' },
  {
    trigger: 'submit-message',
    message: {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: input }],
    },
  },
);
await renderTurn(turn.stream);
