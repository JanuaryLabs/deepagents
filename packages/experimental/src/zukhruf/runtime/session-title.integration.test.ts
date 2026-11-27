import { PGlite } from '@electric-sql/pglite';
import { waitFor } from '@zukhruf/testing/async';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';

import { InMemoryContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { ControlledAgentStorage } from '../../testing/controlled-agent-storage.fixture.ts';
import {
  textResult,
  toolCallResult,
} from '../../testing/stream-results.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { usage } from '../../testing/usage.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const QUESTION = 'How do I renew my passport in Jordan?';

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
  return {
    storage: new ControlledAgentStorage({
      queue: await PgBossTurnQueue.create(boss, {
        pollingIntervalSeconds: 0.5,
        schema: 'pgboss',
      }),
      store: new InMemoryContextStore(),
      streams: streamsFor(
        resources.adopt(new SqliteStreamStore(':memory:'), (store) =>
          store.close(),
        ),
      ),
      mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
    }),
  };
});

function titleResult(title: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ title }) }],
    finishReason: { unified: 'stop' as const, raw: '' },
    usage,
    warnings: [],
  };
}

function answeringModel() {
  return new MockLanguageModelV4({ doStream: async () => textResult('Done.') });
}

test('without a title model the first message titles the session', async () => {
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'clerk',
      model: answeringModel(),
      sandbox: buildSandbox(),
      instructions: [],
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'static', userId: 'owner' };

  const turn = await host.enqueue(conversation, userTurn('first', QUESTION));
  await Array.fromAsync(turn.stream);

  assert.deepStrictEqual(
    (await host.listHistory('owner')).map(({ title }) => title),
    [QUESTION],
  );
});

test('a declared title model titles the session once, and a later turn calls it no more', async () => {
  const titleModel = new MockLanguageModelV4({
    doGenerate: async () => titleResult('Passport renewal'),
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'clerk',
      model: answeringModel(),
      sandbox: buildSandbox(),
      instructions: [],
      title: { model: titleModel },
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'generated', userId: 'owner' };

  const first = await host.enqueue(conversation, userTurn('first', QUESTION));
  await Array.fromAsync(first.stream);
  const second = await host.enqueue(
    conversation,
    userTurn('second', 'And the fee?'),
  );
  await Array.fromAsync(second.stream);

  assert.deepStrictEqual(
    (await host.listHistory('owner')).map(({ title }) => title),
    ['Passport renewal'],
  );
  assert.equal(titleModel.doGenerateCalls.length, 1);
});

test('a title model that fails leaves the first message as the title and the turn completes', async () => {
  const titleModel = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error('the title model is down');
    },
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'clerk',
      model: answeringModel(),
      sandbox: buildSandbox(),
      instructions: [],
      title: { model: titleModel },
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'failing', userId: 'owner' };

  const turn = await host.enqueue(conversation, userTurn('first', QUESTION));
  await Array.fromAsync(turn.stream);

  assert.equal(titleModel.doGenerateCalls.length, 1);
  assert.equal(
    (await host.observe(conversation).status(turn.id))?.status,
    'completed',
  );
  assert.deepStrictEqual(
    (await host.listHistory('owner')).map(({ title }) => title),
    [QUESTION],
  );
});

test('the answer reaches the client while the title model is still running', async (t) => {
  const release = Promise.withResolvers<void>();
  const titleModel = new MockLanguageModelV4({
    doGenerate: async () => {
      await release.promise;
      return titleResult('Passport renewal');
    },
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'clerk',
      model: answeringModel(),
      sandbox: buildSandbox(),
      instructions: [],
      title: { model: titleModel },
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'streaming', userId: 'owner' };

  const turn = await host.enqueue(conversation, userTurn('first', QUESTION));
  const deltas: string[] = [];
  for await (const chunk of turn.stream) {
    if (chunk.type === 'text-delta') deltas.push(chunk.delta);
    if (deltas.length > 0) break;
  }

  assert.deepStrictEqual(deltas, ['Done.']);
  assert.equal(titleModel.doGenerateCalls.length, 1);
  assert.deepStrictEqual(
    (await host.listHistory('owner')).map(({ title }) => title),
    [QUESTION],
  );
  release.resolve();
  await waitFor(
    async () =>
      assert.deepStrictEqual(
        (await host.listHistory('owner')).map(({ title }) => title),
        ['Passport renewal'],
      ),
    { interval: 50, signal: t.signal },
  );
});

test('a sub-agent chat never calls the title model, even when its declaration names one', async (t) => {
  const titleModel = new MockLanguageModelV4({
    doGenerate: async () => titleResult('Passport renewal'),
  });
  const sandbox = buildSandbox();
  const worker = defineAgent({
    name: 'worker',
    model: answeringModel(),
    sandbox,
    instructions: [],
    title: { model: titleModel },
  });
  const rootModel: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () =>
      rootModel.doStreamCalls.length === 1
        ? toolCallResult({
            toolCallId: 'spawn-1',
            toolName: 'spawn_agent',
            input: JSON.stringify({
              agent_type: 'worker',
              task_name: 'lookup',
              message: 'Find the renewal fee',
              fork_turns: 'none',
            }),
          })
        : textResult('Spawned.'),
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'clerk',
      model: rootModel,
      sandbox,
      instructions: [],
      subagents: [worker],
      title: { model: titleModel },
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'tree', userId: 'owner' };

  const turn = await host.enqueue(conversation, userTurn('first', QUESTION));
  await Array.fromAsync(turn.stream);
  await waitFor(
    async () =>
      assert.deepStrictEqual(
        (await host.listHistory('owner')).flatMap(({ children }) =>
          (children ?? []).map(({ state }) => state),
        ),
        ['completed'],
      ),
    { interval: 50, signal: t.signal },
  );

  assert.equal(titleModel.doGenerateCalls.length, 1);
  assert.deepStrictEqual(
    (await host.listHistory('owner')).map(({ title }) => title),
    ['Passport renewal'],
  );
});

test('setSessionTitle stores the trimmed title, and refuses an empty title and a session the caller does not own', async () => {
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'clerk',
      model: answeringModel(),
      sandbox: buildSandbox(),
      instructions: [],
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const conversation = { chatId: 'renamed', userId: 'owner' };
  const turn = await host.enqueue(conversation, userTurn('first', QUESTION));
  await Array.fromAsync(turn.stream);

  await host.setSessionTitle(conversation, '  Trip to Amman  ');
  await assert.rejects(host.setSessionTitle(conversation, ' \n '), {
    name: 'EmptySessionTitleError',
  });
  await assert.rejects(
    host.setSessionTitle({ chatId: 'renamed', userId: 'intruder' }, 'Mine'),
    { name: 'ConversationNotFoundError' },
  );
  await assert.rejects(
    host.setSessionTitle({ chatId: 'absent', userId: 'owner' }, 'Mine'),
    { name: 'ConversationNotFoundError' },
  );

  assert.deepStrictEqual(
    (await host.listHistory('owner')).map(({ title }) => title),
    ['Trip to Amman'],
  );
});
