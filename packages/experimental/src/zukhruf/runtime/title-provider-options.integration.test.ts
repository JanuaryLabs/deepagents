import type {
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { open } from '@zukhruf/sqlite-open';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';

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

const titleResult = (title: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ title }) }],
  finishReason: { unified: 'stop' as const, raw: '' },
  usage,
  warnings: [],
});

test('the title model call carries the providerOptions the turn computes', async () => {
  const titleModel = new MockLanguageModelV4({
    doGenerate: async () => titleResult('Apixaban renal dosing'),
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'clinician',
      model: new MockLanguageModelV4({ doStream: async () => answer() }),
      instructions: [],
      sandbox: sandbox(),
      title: { model: titleModel },
      providerOptions: ({ conversation }) => ({
        openrouter: { user: conversation.userId, provider: { zdr: true } },
      }),
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'titled', userId: 'doctor-1' };

  const turn = await host.enqueue(
    conversation,
    userTurn('first', 'Apixaban dose in renal impairment?'),
  );
  await Array.fromAsync(turn.stream);

  assert.deepStrictEqual(
    titleModel.doGenerateCalls.map((call) => call.providerOptions),
    [{ openrouter: { user: 'doctor-1', provider: { zdr: true } } }],
  );
  assert.deepStrictEqual(
    (await host.listHistory('doctor-1')).map(({ title }) => title),
    ['Apixaban renal dosing'],
  );
});

test('a title model without declaration providerOptions is called with none', async () => {
  const titleModel = new MockLanguageModelV4({
    doGenerate: async () => titleResult('Passport renewal'),
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'clerk',
      model: new MockLanguageModelV4({ doStream: async () => answer() }),
      instructions: [],
      sandbox: sandbox(),
      title: { model: titleModel },
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'plain', userId: 'owner' };

  const turn = await host.enqueue(conversation, userTurn('first', 'Hello.'));
  await Array.fromAsync(turn.stream);

  assert.deepStrictEqual(
    titleModel.doGenerateCalls.map((call) => call.providerOptions),
    [undefined],
  );
});
