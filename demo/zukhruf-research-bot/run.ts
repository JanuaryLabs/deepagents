import { PGlite } from '@electric-sql/pglite';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { styleText } from 'node:util';
import { PgBoss, fromPglite } from 'pg-boss';

import { SqliteContextStore, SqliteStreamStore } from '@deepagents/context';
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

const database = new PGlite('./zukhruf-research.queue');
const boss = new PgBoss({
  db: fromPglite(database),
  backend: 'pglite',
});
boss.on('error', (error) => console.error('[queue error]', error));
await boss.start();
const queue = new PgBossTurnQueue(boss, {
  pollingIntervalSeconds: 0.5,
  schema: 'pgboss',
});
await queue.initialize();
const mailboxStore = new SqliteMailboxStore(
  './zukhruf-research.mailbox.sqlite',
);

const runtime = new AgentRuntime(declaration, {
  store: new SqliteContextStore('./zukhruf-research.sqlite'),
  streamStore: new SqliteStreamStore('./zukhruf-research.streams.sqlite'),
  queue,
  mailboxStore,
});

const conversation = {
  chatId: `research-cli-${crypto.randomUUID()}`,
  userId: process.env.USER ?? 'local',
};
const worker = await runtime.work({ concurrency: 4 });
const terminal = createInterface({ input: stdin, output: stdout });

try {
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
} finally {
  terminal.close();
  await worker[Symbol.asyncDispose]();
  await boss.stop({ graceful: false });
  mailboxStore.close();
}

async function runTurn(input: string): Promise<void> {
  const turn = await runtime.enqueue(conversation, {
    id: crypto.randomUUID(),
    input,
  });
  console.log();
  await renderTurn(turn.stream);
}
