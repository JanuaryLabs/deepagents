import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { open } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import {
  SqliteContextStore,
  SqliteStreamStore,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

import { ControlledAgentStorage } from '../../../testing/controlled-agent-storage.fixture.ts';
import { streamsFor } from '../../../testing/streams-for.fixture.ts';
import { usage } from '../../../testing/usage.fixture.ts';

const MOUNT = '/zukhruf/v1';

const historySchema = z.array(
  z.looseObject({
    chatId: z.string(),
    children: z.array(
      z.looseObject({
        chatId: z.string(),
        path: z.string(),
        state: z.string(),
      }),
    ),
  }),
);
const acceptedBodySchema = z.looseObject({ turnId: z.string() });
const turnStatusSchema = z.looseObject({ status: z.string() });

const text = (value: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: 'text' },
  { type: 'text-delta', id: 'text', delta: value },
  { type: 'text-end', id: 'text' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];
const spawnAgent = (taskName: string): LanguageModelV4StreamPart[] => [
  {
    type: 'tool-call',
    toolCallId: randomUUID(),
    toolName: 'spawn_agent',
    input: JSON.stringify({
      task_name: taskName,
      agent_type: taskName,
      message: 'start',
      fork_turns: 'none',
    }),
  },
  {
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage,
  },
];
const response = (chunks: LanguageModelV4StreamPart[]) => ({
  stream: simulateReadableStream({
    chunks,
    initialDelayInMs: null,
    chunkDelayInMs: null,
  }),
});

test('POST /session answers 429 for an idle sub-agent while its tree has no free agent slot, runs nothing, and accepts it once a slot frees', async (t) => {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(new PGlite());
  const boss = resources.adopt(
    new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
    (value) => value.stop({ graceful: false }),
  );
  boss.on('error', () => {});
  await boss.start();
  const queue = await PgBossTurnQueue.create(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  const scripted: LanguageModelV4StreamPart[][] = [];
  const releaseBlocked = Promise.withResolvers<void>();
  const sandbox = defineSandbox(() =>
    createVirtualSandbox({ fs: new InMemoryFs() }),
  );
  const runtime = resources.use(
    await new AgentRuntime(
      defineAgent({
        name: 'root',
        sandbox,
        instructions: [],
        model: new MockLanguageModelV4({
          doStream: async () => response(scripted.shift() ?? text('root done')),
        }),
        subagents: [
          defineAgent({
            name: 'worker',
            sandbox,
            instructions: [],
            model: new MockLanguageModelV4({
              doStream: async () => response(text('worker done')),
            }),
          }),
          defineAgent({
            name: 'blocked',
            sandbox,
            instructions: [],
            model: new MockLanguageModelV4({
              doStream: async () => {
                await releaseBlocked.promise;
                return response(text('blocked done'));
              },
            }),
          }),
        ],
      }),
    ).initialize(
      defineStack(async () => ({
        storage: new ControlledAgentStorage({
          store: new SqliteContextStore(resources.use(open(':memory:'))),
          streams: streamsFor(
            new SqliteStreamStore(resources.use(open(':memory:'))),
          ),
          queue,
          mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
        }),
        multiAgent: { maxConcurrentThreadsPerSession: 2 },
      })),
    ),
  );
  resources.use(await runtime.work({ concurrency: 4 }));
  resources.defer(() => releaseBlocked.resolve());
  const app = new Hono<HttpEnv>();
  app.use(`${MOUNT}/*`, (context, next) => {
    context.set('userId', 'user-1');
    return next();
  });
  app.route(MOUNT, http(runtime));
  const rootSessionId = randomUUID();
  const post = (sessionId: string) =>
    app.request(`${MOUNT}/session/${sessionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message: {
          id: `message-${randomUUID()}`,
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
        trigger: 'submit-message',
      }),
    });
  const child = async (path: string) => {
    const history = historySchema.parse(
      await (await app.request(`${MOUNT}/history`)).json(),
    );
    const found = history
      .find(({ chatId }) => chatId === rootSessionId)
      ?.children.find((candidate) => candidate.path === path);
    assert.ok(found, `no child at ${path}`);
    return found;
  };
  const rootTurnSpawning = async (taskName: string) => {
    scripted.push(spawnAgent(taskName), text('root done'));
    const accepted = await post(rootSessionId);
    assert.equal(accepted.status, 202);
    const { turnId } = acceptedBodySchema.parse(await accepted.json());
    await waitFor(
      async () => {
        const status = await app.request(
          `${MOUNT}/session/${rootSessionId}/turn/${turnId}`,
        );
        assert.equal(
          turnStatusSchema.parse(await status.json()).status,
          'completed',
        );
      },
      { signal: t.signal },
    );
  };
  await rootTurnSpawning('worker');
  await waitFor(
    async () => assert.equal((await child('/root/worker')).state, 'completed'),
    { signal: t.signal },
  );
  await rootTurnSpawning('blocked');
  await waitFor(
    async () => assert.equal((await child('/root/blocked')).state, 'running'),
    { signal: t.signal },
  );
  const worker = await child('/root/worker');

  const refused = await post(worker.chatId);

  assert.equal(refused.status, 429);
  assert.deepStrictEqual(
    {
      body: await refused.json(),
      workerState: (await child('/root/worker')).state,
    },
    {
      body: {
        error: 'Agent thread limit reached',
        cause: {
          code: 'zukhruf/agent-thread-limit',
          detail: `Every agent slot of session ${worker.chatId}'s tree is busy; retry when one finishes`,
        },
      },
      workerState: 'completed',
    },
  );

  releaseBlocked.resolve();
  await waitFor(
    async () => assert.equal((await child('/root/blocked')).state, 'completed'),
    { signal: t.signal },
  );
  assert.equal((await post(worker.chatId)).status, 202);
});
