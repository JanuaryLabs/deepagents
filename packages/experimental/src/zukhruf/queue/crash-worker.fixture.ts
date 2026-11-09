/**
 * Worker fixture for the crash-recovery test: connects to the Postgres given
 * in argv[2], starts consuming turns with a deliberately slow model, and
 * never exits on its own — the parent test SIGKILLs it mid-turn.
 */
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { PgBoss } from 'pg-boss';

import { PostgresContextStore, PostgresStreamStore } from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';

const connectionString = process.argv[2];
if (!connectionString)
  throw new Error('usage: crash-worker.fixture.ts <connection-string>');

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
} as const;

const glacialModel = new MockLanguageModelV4({
  doStream: {
    stream: simulateReadableStream({
      initialDelayInMs: 100,
      chunkDelayInMs: 500,
      chunks: [
        { type: 'text-start', id: 't1' },
        ...Array.from({ length: 200 }, (_, i) => ({
          type: 'text-delta' as const,
          id: 't1',
          delta: `chunk-${i} `,
        })),
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: '' }, usage },
      ],
    }),
  },
});

const declaration: AgentDeclaration = {
  name: 'crash-agent',
  model: glacialModel,
  sandbox: buildSandbox,
  instructions: [],
};

const boss = new PgBoss(connectionString);
boss.on('error', () => {});
await boss.start();
const queue = await PgBossTurnQueue.create(boss, {
  heartbeatSeconds: 10,
  pollingIntervalSeconds: 0.5,
});

const streamStore = await PostgresStreamStore.create({
  pool: connectionString,
});
const store = await PostgresContextStore.create({ pool: connectionString });
const streams = streamsFor(streamStore);

const runtime = new AgentRuntime(declaration);
const stack = defineStack(async () => ({
  store,
  streams,
  queue,
  mailboxStore: new SqliteMailboxStore(':memory:'),
}));
const host = await runtime.initialize(stack);
await host.work();
console.log('WORKER READY');

const ownerPid = process.ppid;
setInterval(() => {
  if (process.ppid !== ownerPid) process.exit(0);
}, 100);
