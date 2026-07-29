import { PGlite } from '@electric-sql/pglite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

import declaration from './agent.ts';
import {
  groupChatHostDirectory,
  groupChatRunId,
  hostTranscriptPath,
  transcriptPath,
} from './environment.ts';

const proposal =
  'Evaluate a proposal for a new neighborhood park with a playground, a small wetland boardwalk, and an events lawn. The capital budget is $2 million.';

await mkdir(groupChatHostDirectory, { recursive: true });
await writeFile(
  hostTranscriptPath,
  [
    '# Park proposal group chat',
    '',
    '## Objective',
    '',
    'Reach a balanced recommendation that accounts for community, environmental, and budget concerns.',
    '',
    '## Proposal from the user',
    '',
    proposal,
    '',
    '## Public discussion',
    '',
  ].join('\n'),
);

const database = new PGlite();
const boss = new PgBoss({ db: fromPglite(database), backend: 'pglite' });
boss.on('error', (error) => console.error('[queue error]', error));
await boss.start();

const queue = new PgBossTurnQueue(boss, {
  pollingIntervalSeconds: 0.5,
  schema: 'pgboss',
});
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
  await using worker = await runtime.work({ concurrency: 4 });
  void worker;

  const turn = await runtime.enqueue(
    {
      chatId: `group-chat-${groupChatRunId}`,
      userId: process.env.USER ?? 'local',
    },
    {
      id: crypto.randomUUID(),
      input:
        'Moderate the proposal discussion. Select each next speaker, maintain the public transcript, and return the final consensus.',
    },
  );

  await renderTurn(turn.stream);
  console.log(
    `\n\n--- shared transcript (${hostTranscriptPath}, mounted at ${transcriptPath}) ---\n${await readFile(hostTranscriptPath, 'utf8')}`,
  );
} finally {
  await boss.stop({ graceful: false });
  await database.close();
  streamStore.close();
  mailboxStore.close();
}
