import { openai } from '@ai-sdk/openai';
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

import { createSelfExtendingAgentTree } from './agent.ts';
import { createTreeSandboxes } from './sandbox.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: 'string', short: 'C' },
    skills: { type: 'string', short: 'S' },
  },
});
if (!values.workspace || !values.skills) {
  throw new Error(
    'Usage: node run.ts --workspace /path/to/repo --skills /path/to/catalog "Describe the task"',
  );
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required');
}

const input =
  positionals.join(' ').trim() ||
  'Build a TypeScript API with Hono. Use a reusable hono skill; commission it if missing.';
const sandboxes = createTreeSandboxes({
  workspaceDirectory: values.workspace,
  skillsDirectory: values.skills,
});
const model = openai('gpt-5.6-terra');
const root = createSelfExtendingAgentTree({
  root: { model, sandbox: sandboxes.root },
  skillAuthority: { model, sandbox: sandboxes.skillAuthority },
  generalTask: { model, sandbox: sandboxes.generalTask },
});

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
  { chatId: crypto.randomUUID(), userId: process.env.USER ?? 'demo' },
  {
    message: {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: input }],
    },
    trigger: 'submit-message',
  },
);
await renderTurn(turn.stream);
