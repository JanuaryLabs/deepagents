import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { test } from '@zukhruf/parameterized-test';
import { open } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';
import { hasToolCall, isStepCount, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import {
  SqliteContextStore,
  SqliteStreamStore,
  VirtualSandboxEnvironment,
} from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { ControlledAgentStorage } from '../../testing/controlled-agent-storage.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { usage } from '../../testing/usage.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const stack = defineStack(async (resources) => {
  const database = resources.use(new PGlite());
  const boss = resources.adopt(
    new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
    (boss) => boss.stop({ graceful: false }),
  );
  boss.on('error', (error) => {
    throw error;
  });
  await boss.start();
  const store = new SqliteStreamStore(resources.use(open(':memory:')));
  return {
    storage: new ControlledAgentStorage({
      queue: await PgBossTurnQueue.create(boss, {
        pollingIntervalSeconds: 0.5,
        schema: 'pgboss',
      }),
      store: new SqliteContextStore(resources.use(open(':memory:'))),
      streams: streamsFor(store),
      mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
    }),
  };
});

void test.each(
  [isStepCount(1), [hasToolCall('notify'), isStepCount(6)]],
  (stopWhen) =>
    test(`queued sandboxed agent honors ${Array.isArray(stopWhen) ? 'tool' : 'step'} stop condition`, async () => {
      // Only inference is prescribed; queue, runtime, tools, history and streams are real.
      const model: MockLanguageModelV4 = new MockLanguageModelV4({
        doStream: async () => {
          assert.equal(
            model.doStreamCalls.length,
            1,
            'stopWhen must prevent another sample',
          );
          return {
            stream: ReadableStream.from([
              {
                type: 'tool-call' as const,
                toolCallId: 'notify-1',
                toolName: 'notify',
                input: '{}',
              },
              {
                type: 'finish' as const,
                finishReason: {
                  unified: 'tool-calls' as const,
                  raw: undefined,
                },
                usage,
              },
            ]),
          };
        },
      });
      let deliveries = 0;
      const declaration = defineAgent({
        name: 'observer',
        model,
        instructions: [],
        stopWhen,
        sandbox: defineSandbox(new VirtualSandboxEnvironment()),
        tools: {
          notify: tool({
            inputSchema: z.object({}),
            execute: () => ++deliveries,
          }),
        },
      });
      const runtime = new AgentRuntime(declaration);
      await using host = await runtime.initialize(stack);
      const conversation = { chatId: 'observations', userId: 'owner' };
      const turn = await host.enqueue(
        conversation,
        userTurn('event-1', 'Notify once.'),
      );
      await host.work();
      await Array.fromAsync(turn.stream);
      assert.equal(
        (await host.observe(conversation).status(turn.id))?.status,
        'completed',
      );
      assert.equal(deliveries, 1);
      assert.equal(model.doStreamCalls.length, 1);
      const names = model.doStreamCalls[0].tools?.map((tool) => tool.name);
      for (const name of ['bash', 'readFile', 'writeFile'])
        assert.equal(names?.includes(name), true);
    }),
);

test('a truncated tool input cannot park the next queued user turn', async (t) => {
  let queryExecutions = 0;
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => ({
      stream: ReadableStream.from<LanguageModelV4StreamPart>(
        model.doStreamCalls.length === 1
          ? [
              {
                type: 'tool-input-start' as const,
                id: 'cut',
                toolName: 'query',
              },
              {
                type: 'tool-input-delta' as const,
                id: 'cut',
                delta: '{"sql":"SELECT',
              },
              {
                type: 'finish' as const,
                finishReason: { unified: 'length' as const, raw: 'length' },
                usage,
              },
            ]
          : [
              { type: 'text-start' as const, id: 'text' },
              {
                type: 'text-delta' as const,
                id: 'text',
                delta: 'The next change was processed.',
              },
              { type: 'text-end' as const, id: 'text' },
              {
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: 'stop' },
                usage,
              },
            ],
      ),
    }),
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'truncated',
      model,
      instructions: [],
      stopWhen: isStepCount(1),
      sandbox: defineSandbox(new VirtualSandboxEnvironment()),
      tools: {
        query: tool({
          inputSchema: z.object({ sql: z.string() }),
          execute: () => ++queryExecutions,
        }),
      },
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'truncated', userId: 'owner' };
  const first = await host.enqueue(
    conversation,
    userTurn('first', 'Inspect this change.'),
  );
  const chunks = await Array.fromAsync(first.stream);
  assert.ok(
    chunks.some(
      (chunk) => chunk.type === 'finish' && chunk.finishReason === 'length',
    ),
  );
  const second = await host.enqueue(
    conversation,
    userTurn('second', 'Here is the next change.'),
  );
  await second.stream.cancel();
  await waitFor(
    async () =>
      assert.equal(
        (await host.observe(conversation).status(second.id))?.status,
        'completed',
      ),
    { signal: t.signal },
  );
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(queryExecutions, 0, 'An incomplete call cannot execute');
});

test('the turns of one chat borrow one sandbox, which stays open between turns, also after a failed turn, and the host closes it at its end', async (t) => {
  // A handle can hold a connection (a named microVM refuses every connect
  // after about 107 open ones), so the chat keeps one.
  let created = 0;
  let open = 0;
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () => {
      if (model.doStreamCalls.length === 2)
        throw new Error('The provider is down');
      return {
        stream: ReadableStream.from<LanguageModelV4StreamPart>([
          { type: 'text-start' as const, id: 'text' },
          { type: 'text-delta' as const, id: 'text', delta: 'Done.' },
          { type: 'text-end' as const, id: 'text' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage,
          },
        ]),
      };
    },
  });
  const environment = new VirtualSandboxEnvironment();
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'shared',
      model,
      instructions: [],
      stopWhen: isStepCount(1),
      sandbox: defineSandbox({
        open: async (chat) => {
          const backend = await environment.open(chat);
          created++;
          open++;
          const { close } = backend;
          const closed = async () => {
            open--;
            await close();
          };
          return Object.assign(backend, {
            close: closed,
            [Symbol.asyncDispose]: closed,
          });
        },
        delete: (chat) => environment.delete(chat),
      }),
    }),
  );
  const conversation = { chatId: 'shared', userId: 'owner' };
  const message = (id: string) => userTurn(id, id);
  {
    await using host = await runtime.initialize(stack);
    await host.work();
    const completed = await host.enqueue(conversation, message('first'));
    await Array.fromAsync(completed.stream);
    const failed = await host.enqueue(conversation, message('second'));
    await Array.fromAsync(failed.stream);
    const view = host.observe(conversation);
    await waitFor(
      async () =>
        assert.equal((await view.status(failed.id))?.status, 'failed'),
      { interval: 50, signal: t.signal },
    );
    const third = await host.enqueue(conversation, message('third'));
    await Array.fromAsync(third.stream);

    assert.equal((await view.status(third.id))?.status, 'completed');
    assert.equal(created, 1);
    assert.equal(open, 1);
  }

  assert.equal(open, 0);
});
