import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryContextStore,
  SqliteStreamStore,
  type StreamUpdater,
} from '@deepagents/context';
import {
  AgentRuntime,
  MessageDeliveryModes,
  SqliteMailboxStore,
  createInterAgentCommunication,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { ControlledTurnQueue } from '../../testing/controlled-turn-queue.fixture.ts';
import { textResult } from '../../testing/stream-results.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { usage } from '../../testing/usage.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

class CancelAfterStatusReadStreamStore extends SqliteStreamStore {
  readonly #armed: StreamUpdater[] = [];

  arm(): void {
    this.#armed.push(({ status }) => {
      if (status !== 'queued' && status !== 'running') return undefined;
      const now = Date.now();
      return {
        status: 'cancelled',
        cancelRequestedAt: now,
        finishedAt: now,
      };
    });
  }

  override async updateStream(streamId: string, update: StreamUpdater) {
    const armed = this.#armed.shift();
    if (armed) await super.updateStream(streamId, armed);
    return super.updateStream(streamId, update);
  }
}

class ConcurrentRootMetadataStore extends InMemoryContextStore {
  readonly #hostWrites = [{ concurrentHostValue: 'preserved' }];

  override async updateChat(
    chatId: string,
    update: Parameters<InMemoryContextStore['updateChat']>[1],
  ) {
    const hostWrite = this.#hostWrites.shift();
    if (hostWrite) {
      await super.updateChat(chatId, ({ metadata }) => ({
        metadata: { ...metadata, ...hostWrite },
      }));
    }
    return super.updateChat(chatId, update);
  }
}

test('enqueue only queues; worker execution initializes root metadata', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });

  await store.upsertChat({
    id: 'root-chat',
    userId: 'user-1',
    metadata: { application: 'preserved' },
  });

  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => textResult('hello'),
      }),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack);

  const enqueued = await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    userTurn('turn-1', 'hello'),
  );

  assert.deepEqual((await store.getChat('root-chat'))?.metadata, {
    application: 'preserved',
  });

  await using _worker = await runtime.work();

  void _worker;
  await queue.runNext();

  const chat = await store.getChat('root-chat');
  assert.equal(chat?.metadata?.application, 'preserved');
  assert.equal(chat?.metadata?.zukhrufTreeId, 'root-chat');
  assert.deepEqual(chat?.metadata?.zukhruf, {
    path: '/root',
    parentChatId: null,
    declarationName: 'root',
    lastTurnId: enqueued.id,
  });
});

test('an existing chat can only be used by its stored owner', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });

  await store.upsertChat({ id: 'shared-chat', userId: 'alice' });

  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ],
          }),
        }),
      }),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack2 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack2);
  const intruder = { chatId: 'shared-chat', userId: 'bob' };

  await assert.rejects(
    runtime.enqueue(intruder, userTurn('intruder-turn', 'hello')),
    /chat "shared-chat" belongs to user "alice", not "bob"/,
  );
  assert.equal(queue.turns.length, 0);
  assert.equal(await streamStore.getStreamStatus('intruder-turn'), undefined);

  await assert.rejects(
    runtime.observe(intruder).engine.getMessages(),
    /chat "shared-chat" belongs to user "alice", not "bob"/,
  );
});

test('caller turn ids are scoped to their owning conversation', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4(),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack3 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack3);

  const alice = await runtime.enqueue(
    { chatId: 'alice-chat', userId: 'alice' },
    userTurn('shared-caller-id', 'alice secret'),
  );
  const bob = await runtime.enqueue(
    { chatId: 'bob-chat', userId: 'bob' },
    userTurn('shared-caller-id', 'bob request'),
  );

  assert.notEqual(alice.id, bob.id);
  assert.notEqual(queue.turns[0]?.streamId, queue.turns[1]?.streamId);
});

test('explicit cancellation rejects a stream owned by another conversation', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4(),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack4 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack4);
  const alice = await runtime.enqueue(
    { chatId: 'alice-chat', userId: 'alice' },
    userTurn('alice-turn', 'alice secret'),
  );

  await assert.rejects(
    runtime.observe({ chatId: 'bob-chat', userId: 'bob' }).cancel(alice.id),
    /stream .* does not belong to conversation/,
  );
  assert.equal(await streamStore.getStreamStatus(alice.id), 'queued');
});

test('reserved but malformed agent metadata fails closed at enqueue', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });
  await store.createChat({
    id: 'corrupt-child',
    userId: 'user-1',
    metadata: {
      zukhrufTreeId: 'root-chat',
      zukhruf: {
        path: '/root/researcher',
        parentChatId: null,
        declarationName: 'researcher',
      },
    },
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4(),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack5 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack5);

  await assert.rejects(
    runtime.enqueue(
      { chatId: 'corrupt-child', userId: 'user-1' },
      userTurn('must-not-queue', 'hello'),
    ),
    /invalid Zukhruf metadata for chat "corrupt-child"/,
  );
  assert.equal(queue.turns.length, 0);
  assert.equal(await streamStore.getStreamStatus('must-not-queue'), undefined);
});

test('enqueue rejects an empty conversation before registering a stream', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4(),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack6 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack6);

  await assert.rejects(
    runtime.enqueue(
      { chatId: '', userId: 'user-1' },
      userTurn('must-not-register', 'hello'),
    ),
    /conversation requires non-empty chatId and userId/,
  );
  assert.deepStrictEqual(await streamStore.listStreamIds(), []);
  assert.equal(queue.turns.length, 0);
});

test('root initialization preserves a concurrent host metadata write', async () => {
  const store = new ConcurrentRootMetadataStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });
  await store.createChat({
    id: 'root-cas',
    userId: 'user-1',
    metadata: { application: 'preserved' },
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ],
          }),
        }),
      }),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack7 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack7);
  await runtime.enqueue(
    { chatId: 'root-cas', userId: 'user-1' },
    userTurn('root-cas-turn', 'hello'),
  );

  await using _worker = await runtime.work();

  void _worker;
  await queue.runNext();

  const metadata = (await store.getChat('root-cas'))?.metadata;
  assert.equal(metadata?.application, 'preserved');
  assert.equal(metadata?.concurrentHostValue, 'preserved');
  assert.equal(metadata?.zukhrufTreeId, 'root-cas');
});

test('a child must point to the immediate ancestor of its canonical path', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });
  await store.createChat({
    id: 'root-chat',
    userId: 'user-1',
    metadata: {
      zukhrufTreeId: 'root-chat',
      zukhruf: {
        path: '/root',
        parentChatId: null,
        declarationName: 'root',
      },
    },
  });
  await store.createChat({
    id: 'skips-parent',
    userId: 'user-1',
    metadata: {
      zukhrufTreeId: 'root-chat',
      zukhruf: {
        path: '/root/team/researcher',
        parentChatId: 'root-chat',
        declarationName: 'researcher',
      },
    },
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4(),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack8 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack8);

  await assert.rejects(
    runtime.enqueue(
      { chatId: 'skips-parent', userId: 'user-1' },
      userTurn('must-not-skip-parent', 'hello'),
    ),
    /invalid Zukhruf parent for chat "skips-parent"/,
  );
  assert.equal(queue.turns.length, 0);
});

test('host delivery rejects a recipient that does not own the stored chat', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });

  await store.upsertChat({ id: 'shared-chat', userId: 'alice' });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4(),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack9 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack9);
  const recipient = { chatId: 'shared-chat', userId: 'bob' };

  await assert.rejects(
    runtime.deliver(
      createInterAgentCommunication({
        author: { chatId: 'sender', userId: 'alice' },
        recipient,
        content: 'poison mail',
      }),
      MessageDeliveryModes.TriggerTurn,
    ),
    /chat "shared-chat" belongs to user "alice", not "bob"/,
  );
  assert.equal(await mailboxStore.hasPending(recipient), false);
  assert.equal(queue.turns.length, 0);
});

test('explicit cancellation rejects a conversation that does not own the stored chat', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });

  await store.upsertChat({ id: 'shared-chat', userId: 'alice' });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4(),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack10 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack10);
  const alice = await runtime.enqueue(
    { chatId: 'shared-chat', userId: 'alice' },
    userTurn('alice-turn', 'hello'),
  );

  await assert.rejects(
    runtime
      .observe({ chatId: 'shared-chat', userId: 'bob' })
      .cancel('alice-turn'),
    /chat "shared-chat" belongs to user "alice", not "bob"/,
  );
  assert.equal(await streamStore.getStreamStatus(alice.id), 'queued');
});

test('cancelling during sandbox setup prevents model sampling', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  const sandboxStarted = Promise.withResolvers<void>();
  const releaseSandbox = Promise.withResolvers<void>();
  let modelCalls = 0;
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => {
          modelCalls++;
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: '' },
                  usage,
                },
              ],
            }),
          };
        },
      }),
      sandbox: async () => {
        sandboxStarted.resolve();
        await releaseSandbox.promise;
        return buildSandbox();
      },
      instructions: [],
    }),
  );
  const runtimeStack11 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack11);
  const conversation = { chatId: 'cancel-setup', userId: 'user-1' };
  const enqueued = await runtime.enqueue(
    conversation,
    userTurn('cancel-during-sandbox', 'never sample this'),
  );
  await using _worker = await runtime.work();
  void _worker;
  const running = queue.runNext();
  await sandboxStarted.promise;

  await runtime.observe(conversation).cancel(enqueued.id);
  releaseSandbox.resolve();
  await running;

  await t.waitFor(
    async () =>
      assert.equal(await streamStore.getStreamStatus(enqueued.id), 'cancelled'),
    { interval: 20, timeout: 5_000 },
  );
  assert.equal(modelCalls, 0);
});

test('cancellation that wins the execution claim prevents model sampling', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new CancelAfterStatusReadStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  let modelCalls = 0;
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => {
          modelCalls++;
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: '' },
                  usage,
                },
              ],
            }),
          };
        },
      }),
      sandbox: async () => {
        streamStore.arm();
        return buildSandbox();
      },
      instructions: [],
    }),
  );
  const runtimeStack12 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack12);
  const conversation = { chatId: 'cancel-claim', userId: 'user-1' };
  const enqueued = await runtime.enqueue(
    conversation,
    userTurn('cancel-before-claim', 'never sample this either'),
  );

  await using _worker = await runtime.work();

  void _worker;
  await queue.runNext();

  assert.equal(await streamStore.getStreamStatus(enqueued.id), 'cancelled');
  assert.equal(modelCalls, 0);
});

test('cancellation after execution claim aborts pending provider setup', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  const providerStarted = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  let providerSignal: AbortSignal | undefined;
  using stores = new DisposableStack();
  stores.defer(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => {
          providerSignal = abortSignal;
          providerStarted.resolve();
          await releaseProvider.promise;
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: '' },
                  usage,
                },
              ],
            }),
          };
        },
      }),
      sandbox: buildSandbox,
      instructions: [],
    }),
  );
  const runtimeStack13 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack13);
  const conversation = { chatId: 'cancel-provider', userId: 'user-1' };
  const enqueued = await runtime.enqueue(
    conversation,
    userTurn('cancel-pending-provider', 'start slowly'),
  );
  await using _worker = await runtime.work();
  void _worker;
  const running = queue.runNext();
  await providerStarted.promise;

  await runtime.observe(conversation).cancel(enqueued.id);
  await t.waitFor(() => assert.equal(providerSignal?.aborted, true), {
    interval: 20,
    timeout: 5_000,
  });
  const aborted = providerSignal?.aborted;
  releaseProvider.resolve();
  await running;

  assert.equal(aborted, true);
  assert.equal(await streamStore.getStreamStatus(enqueued.id), 'cancelled');
});
