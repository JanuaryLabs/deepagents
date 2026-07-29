import { PGlite } from '@electric-sql/pglite';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  PollingChangeSource,
  SqliteContextStore,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  renderTurn,
} from '@deepagents/experimental/zukhruf';

import declaration from './agent.ts';

const initialQuery =
  process.argv.slice(2).join(' ') ||
  'What are the most promising approaches to grid-scale energy storage in 2026?';

await using resources = new AsyncDisposableStack();

const database = resources.adopt(
  new PGlite('./zukhruf-research.queue'),
  (database) => database.close(),
);
const boss = resources.adopt(
  new PgBoss({
    db: fromPglite(database),
    backend: 'pglite',
  }),
  (boss) => boss.stop({ graceful: false }),
);
boss.on('error', (error) => console.error('[queue error]', error));
await boss.start();
const queue = new PgBossTurnQueue(boss, {
  pollingIntervalSeconds: 0.5,
  schema: 'pgboss',
});
await queue.initialize();
const mailboxStore = resources.use(
  new SqliteMailboxStore('./zukhruf-research.mailbox.sqlite'),
);
const streamStore = resources.adopt(
  new SqliteStreamStore('./zukhruf-research.streams.sqlite'),
  (store) => store.close(),
);
const streams = new StreamManager({
  store: streamStore,
  changeSource: new PollingChangeSource({ reads: streamStore }),
});

const runtime = new AgentRuntime(declaration, {
  store: new SqliteContextStore('./zukhruf-research.sqlite'),
  streams,
  queue,
  mailboxStore,
});

const conversation = {
  chatId: `research-cli-${crypto.randomUUID()}`,
  userId: process.env.USER ?? 'local',
};
resources.use(await runtime.work({ concurrency: 4 }));
const terminal = resources.adopt(
  createInterface({ input: stdin, output: stdout }),
  (terminal) => terminal.close(),
);

await runTurn(initialQuery);
console.log(
  styleText(
    'dim',
    [
      'researchers keep working in the background; findings arrive on later turns.',
      'try: "Synthesize every researcher finding received so far." — /exit to quit',
    ].join('\n'),
  ),
);

while (true) {
  const input = (await terminal.question('\nresearch> ')).trim();
  if (input === '/exit') break;
  if (!input) continue;
  await runTurn(input);
}

async function runTurn(input: string): Promise<void> {
  const turn = await runtime.enqueue(conversation, {
    id: crypto.randomUUID(),
    input,
  });
  console.log();
  await renderTurn(turn.stream);
}
