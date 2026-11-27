import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { open } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';
import { type ModelMessage, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import { messagesExceed } from '@deepagents/compaction';
import {
  SqliteContextStore,
  SqliteStreamStore,
  VirtualSandboxEnvironment,
} from '@deepagents/context';
import {
  type AgentPluginToolContext,
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

const answer = (): LanguageModelV4StreamResult => ({
  stream: ReadableStream.from<LanguageModelV4StreamPart>([
    { type: 'text-start', id: 'answer' },
    { type: 'text-delta', id: 'answer', delta: 'Done.' },
    { type: 'text-end', id: 'answer' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
    },
  ]),
});

const sandbox = () => defineSandbox(new VirtualSandboxEnvironment());

test('a static providerOptions value reaches the model call', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => answer() });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'static',
      model,
      instructions: [],
      sandbox: sandbox(),
      providerOptions: { openrouter: { user: 'clinic' } },
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'static', userId: 'owner' };

  const turn = await host.enqueue(conversation, userTurn('first', 'Hello.'));
  await Array.fromAsync(turn.stream);

  assert.equal(
    (await host.observe(conversation).status(turn.id))?.status,
    'completed',
  );
  assert.deepStrictEqual(
    model.doStreamCalls.map((call) => call.providerOptions),
    [{ openrouter: { user: 'clinic' } }],
  );
});

test('each conversation on one runtime sends the providerOptions its turn computes', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => answer() });
  const seen: AgentPluginToolContext[] = [];
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'clinician',
      model,
      instructions: [],
      sandbox: sandbox(),
      providerOptions: async (context) => {
        seen.push(context);
        return { openrouter: { user: context.conversation.userId } };
      },
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const first = { chatId: 'chat-1', userId: 'doctor-1' };
  const second = { chatId: 'chat-2', userId: 'doctor-2' };

  const one = await host.enqueue(first, userTurn('one', 'Dose?'));
  await Array.fromAsync(one.stream);
  const two = await host.enqueue(second, userTurn('two', 'Interactions?'));
  await Array.fromAsync(two.stream);

  assert.deepStrictEqual(
    model.doStreamCalls.map((call) => call.providerOptions),
    [
      { openrouter: { user: 'doctor-1' } },
      { openrouter: { user: 'doctor-2' } },
    ],
  );
  assert.deepStrictEqual(
    seen.map(({ conversation, agentName }) => ({ conversation, agentName })),
    [
      { conversation: first, agentName: 'clinician' },
      { conversation: second, agentName: 'clinician' },
    ],
  );
});

test('every step of a turn carries the providerOptions', async () => {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () =>
      model.doStreamCalls.length === 1
        ? {
            stream: ReadableStream.from<LanguageModelV4StreamPart>([
              {
                type: 'tool-call',
                toolCallId: 'lookup-1',
                toolName: 'lookup',
                input: '{}',
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ]),
          }
        : answer(),
  });
  let lookups = 0;
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'stepper',
      model,
      instructions: [],
      sandbox: sandbox(),
      tools: {
        lookup: tool({
          inputSchema: z.object({}),
          execute: () => ++lookups,
        }),
      },
      providerOptions: ({ conversation }) => ({
        openrouter: { user: conversation.userId },
      }),
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'steps', userId: 'doctor-1' };

  const turn = await host.enqueue(conversation, userTurn('first', 'Look up.'));
  await Array.fromAsync(turn.stream);

  assert.equal(lookups, 1);
  assert.deepStrictEqual(
    model.doStreamCalls.map((call) => call.providerOptions),
    [
      { openrouter: { user: 'doctor-1' } },
      { openrouter: { user: 'doctor-1' } },
    ],
  );
});

test('a turn that compacts still sends the providerOptions on the call after compaction', async () => {
  const model = new MockLanguageModelV4({ doStream: async () => answer() });
  const summarizer = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: 'Earlier findings: CASE-42.' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    },
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'compacting',
      model,
      instructions: [],
      sandbox: sandbox(),
      compaction: {
        model: summarizer,
        triggers: [messagesExceed(2)],
        targetTokens: 4_000,
        keepLastMessages: 2,
        countTokens: (messages: readonly ModelMessage[]) =>
          JSON.stringify(messages).length,
      },
      providerOptions: ({ conversation }) => ({
        openrouter: { user: conversation.userId },
      }),
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'compacting', userId: 'doctor-1' };
  const first = await host.enqueue(
    conversation,
    userTurn('first', 'Prior findings. '.repeat(700)),
  );
  await Array.fromAsync(first.stream);

  const second = await host.enqueue(
    conversation,
    userTurn('second', 'Continue CASE-42.'),
  );
  const chunks = await Array.fromAsync(second.stream);

  assert.deepStrictEqual(
    chunks.flatMap((chunk) =>
      chunk.type === 'data-compaction' &&
      z.object({ status: z.string() }).parse(chunk.data).status === 'completed'
        ? ['completed']
        : [],
    ),
    ['completed'],
  );
  assert.equal(summarizer.doGenerateCalls.length, 1);
  assert.deepStrictEqual(
    model.doStreamCalls.map((call) => call.providerOptions),
    [
      { openrouter: { user: 'doctor-1' } },
      { openrouter: { user: 'doctor-1' } },
    ],
  );
});

test('a providerOptions function that rejects fails the turn before the model is called', async (t) => {
  const model = new MockLanguageModelV4({ doStream: async () => answer() });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'rejecting',
      model,
      instructions: [],
      sandbox: sandbox(),
      providerOptions: async () => {
        throw new Error('the user directory is unreachable');
      },
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'rejecting', userId: 'doctor-1' };

  const turn = await host.enqueue(conversation, userTurn('first', 'Hello.'));

  const settled = await waitFor(
    async () => {
      const status = await host.observe(conversation).status(turn.id);
      assert.ok(status?.status !== 'queued' && status?.status !== 'running');
      return status?.status;
    },
    { interval: 50, signal: t.signal },
  );

  assert.equal(settled, 'failed');
  assert.equal(model.doStreamCalls.length, 0);
});
