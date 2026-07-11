/**
 * Worker fixture for the crash-recovery test: connects to the Postgres given
 * in argv[2], starts consuming turns with a deliberately slow model, and
 * never exits on its own — the parent test SIGKILLs it mid-turn.
 */
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import { PgBoss } from 'pg-boss';

import {
  type AgentSandbox,
  PostgresContextStore,
  PostgresStreamStore,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';

import type { AgentDeclaration } from '../agent.ts';
import { createRuntime } from '../runtime.ts';
import { PgBossTurnQueue } from './pg-boss.turn-queue.ts';

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
  doStream: async () => ({
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
    rawCall: { rawPrompt: undefined, rawSettings: {} },
  }),
});

const declaration: AgentDeclaration = {
  name: 'crash-agent',
  model: glacialModel,
  sandbox: async (): Promise<AgentSandbox> =>
    createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    }),
  instructions: [],
};

const boss = new PgBoss(connectionString);
boss.on('error', () => {});
await boss.start();
const queue = new PgBossTurnQueue(boss, {
  heartbeatSeconds: 10,
  pollingIntervalSeconds: 0.5,
});
await queue.initialize();

const streamStore = new PostgresStreamStore({ pool: connectionString });
await streamStore.initialize();
const store = new PostgresContextStore({ pool: connectionString });
await store.initialize();

const runtime = createRuntime(declaration, { store, streamStore, queue });
await runtime.work();
console.log('WORKER READY');

setInterval(() => {}, 1 << 30);
