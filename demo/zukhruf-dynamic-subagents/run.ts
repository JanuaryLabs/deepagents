import { PGlite } from '@electric-sql/pglite';
import { parseArgs } from 'node:util';
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
import { fileAgents } from '@deepagents/experimental/zukhruf/file-agents';

import { createCodingAgent } from './agent.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string', short: 'C' },
  },
});
const input = positionals.join(' ').trim();
if (!input) {
  throw new Error(
    'Usage: node run.ts --workspace /path/to/repo "Describe the feature"',
  );
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required');
}

const root = createCodingAgent(values.workspace ?? process.cwd());
await using resources = new AsyncDisposableStack();
const database = resources.adopt(new PGlite(), (database) => database.close());
const boss = resources.adopt(
  new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
  (boss) => boss.stop(),
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
  plugins: [
    fileAgents({
      directory: new URL('./agents/subagents/', import.meta.url),
    }),
  ],
});
resources.use(await runtime.work({ concurrency: 4 }));

const turn = await runtime.enqueue(
  { chatId: crypto.randomUUID(), userId: process.env.USER ?? 'demo' },
  { id: crypto.randomUUID(), input },
);
await renderTurn(turn.stream);
