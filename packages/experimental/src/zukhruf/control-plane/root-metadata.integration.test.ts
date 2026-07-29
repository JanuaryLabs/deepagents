import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AgentModel,
  type AgentSandbox,
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
  type StreamStore,
  type StreamUpdater,
} from '@deepagents/context';
import {
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  MessageDeliveryMode,
  SqliteMailboxStore,
  TurnQueue,
  type TurnRef,
  createInterAgentCommunication,
  defineAgent,
} from '@deepagents/experimental/zukhruf';

function streamsFor(store: StreamStore): StreamManager {
  return new StreamManager({
    store,
    changeSource: new PollingChangeSource({ reads: store }),
  });
}

class RecordingTurnQueue extends TurnQueue {
  readonly turns: TurnRef[] = [];
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;

  override async push(turn: TurnRef) {
    this.turns.push(turn);
    return { jobId: turn.streamId, inserted: true };
  }

  override async getTurnActivity(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<'idle' | 'queued' | 'running'> {
    return this.turns.some(
      (turn) =>
        turn.chatId === conversation.chatId &&
        turn.userId === conversation.userId,
    )
      ? 'queued'
      : 'idle';
  }

  override async getCurrentTurn(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<TurnRef | undefined> {
    return this.turns.find(
      (turn) =>
        turn.chatId === conversation.chatId &&
        turn.userId === conversation.userId,
    );
  }

  override async cancel(streamId: string): Promise<void> {
    const remaining = this.turns.filter((turn) => turn.streamId !== streamId);
    this.turns.splice(0, this.turns.length, ...remaining);
  }

  override async consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    _options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    this.#handler = handler;
    return {
      [Symbol.asyncDispose]: async () => {
        this.#handler = undefined;
      },
    };
  }

  override async resumeParked(): Promise<void> {}

  async runNext(): Promise<void> {
    const turn = this.turns.shift();
    assert.ok(turn, 'expected a queued turn');
    assert.ok(this.#handler, 'expected a running worker');
    await this.#handler(turn, {
      signal: new AbortController().signal,
      park: async () => {
        throw new Error('turn unexpectedly parked');
      },
    });
  }
}

class CancelAfterStatusReadStreamStore extends SqliteStreamStore {
  #armed = false;

  arm(): void {
    this.#armed = true;
  }

  override async updateStream(streamId: string, update: StreamUpdater) {
    if (this.#armed) {
      this.#armed = false;
      await super.updateStream(streamId, ({ status }) => {
        if (status !== 'queued' && status !== 'running') return undefined;
        const now = Date.now();
        return {
          status: 'cancelled',
          cancelRequestedAt: now,
          finishedAt: now,
        };
      });
    }
    return super.updateStream(streamId, update);
  }
}

class ConcurrentRootMetadataStore extends InMemoryContextStore {
  #injectHostWrite = true;

  override async updateChat(
    chatId: string,
    update: Parameters<InMemoryContextStore['updateChat']>[1],
  ) {
    if (this.#injectHostWrite) {
      this.#injectHostWrite = false;
      await super.updateChat(chatId, ({ metadata }) => ({
        metadata: { ...metadata, concurrentHostValue: 'preserved' },
      }));
    }
    return super.updateChat(chatId, update);
  }
}

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

test('enqueue only queues; worker execution initializes root metadata', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  await store.upsertChat({
    id: 'root-chat',
    userId: 'user-1',
    metadata: { application: 'preserved' },
  });

  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'hello' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ],
          }),
        }),
      }) as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );

  const enqueued = await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'turn-1', input: 'hello' },
  );

  assert.deepEqual((await store.getChat('root-chat'))?.metadata, {
    application: 'preserved',
  });

  await using _worker = await runtime.work();
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

test('an existing chat can only be used by its stored owner', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  await store.upsertChat({ id: 'shared-chat', userId: 'alice' });

  const runtime = new AgentRuntime(
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
      }) as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );
  const intruder = { chatId: 'shared-chat', userId: 'bob' };

  await assert.rejects(
    runtime.enqueue(intruder, { id: 'intruder-turn', input: 'hello' }),
    /chat "shared-chat" belongs to user "alice", not "bob"/,
  );
  assert.equal(queue.turns.length, 0);
  assert.equal(await streamStore.getStreamStatus('intruder-turn'), undefined);

  await assert.rejects(
    runtime.observe(intruder).engine.getMessages(),
    /chat "shared-chat" belongs to user "alice", not "bob"/,
  );
  await assert.rejects(
    runtime.approve(intruder, { toolCallId: 'call-1' }),
    /chat "shared-chat" belongs to user "alice", not "bob"/,
  );
});

test('caller turn ids are scoped to their owning conversation', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: {} as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );

  const alice = await runtime.enqueue(
    { chatId: 'alice-chat', userId: 'alice' },
    { id: 'shared-caller-id', input: 'alice secret' },
  );
  const bob = await runtime.enqueue(
    { chatId: 'bob-chat', userId: 'bob' },
    { id: 'shared-caller-id', input: 'bob request' },
  );

  assert.notEqual(alice.id, bob.id);
  assert.notEqual(queue.turns[0]?.streamId, queue.turns[1]?.streamId);
});

test('explicit cancellation rejects a stream owned by another conversation', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: {} as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );
  const alice = await runtime.enqueue(
    { chatId: 'alice-chat', userId: 'alice' },
    { id: 'alice-turn', input: 'alice secret' },
  );

  await assert.rejects(
    runtime.observe({ chatId: 'bob-chat', userId: 'bob' }).cancel(alice.id),
    /stream .* does not belong to conversation/,
  );
  assert.equal(await streamStore.getStreamStatus(alice.id), 'queued');
});

test('reserved but malformed agent metadata fails closed at enqueue', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  t.after(() => {
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
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: {} as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );

  await assert.rejects(
    runtime.enqueue(
      { chatId: 'corrupt-child', userId: 'user-1' },
      { id: 'must-not-queue', input: 'hello' },
    ),
    /invalid Zukhruf metadata for chat "corrupt-child"/,
  );
  assert.equal(queue.turns.length, 0);
  assert.equal(await streamStore.getStreamStatus('must-not-queue'), undefined);
});

test('enqueue rejects an empty conversation before registering a stream', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: {} as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );

  await assert.rejects(
    runtime.enqueue(
      { chatId: '', userId: 'user-1' },
      { id: 'must-not-register', input: 'hello' },
    ),
    /conversation requires non-empty chatId and userId/,
  );
  assert.deepStrictEqual(await streamStore.listStreamIds(), []);
  assert.equal(queue.turns.length, 0);
});

test('root initialization preserves a concurrent host metadata write', async (t) => {
  const store = new ConcurrentRootMetadataStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });
  await store.createChat({
    id: 'root-cas',
    userId: 'user-1',
    metadata: { application: 'preserved' },
  });
  const runtime = new AgentRuntime(
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
      }) as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );
  await runtime.enqueue(
    { chatId: 'root-cas', userId: 'user-1' },
    { id: 'root-cas-turn', input: 'hello' },
  );

  await using _worker = await runtime.work();
  await queue.runNext();

  const metadata = (await store.getChat('root-cas'))?.metadata;
  assert.equal(metadata?.application, 'preserved');
  assert.equal(metadata?.concurrentHostValue, 'preserved');
  assert.equal(metadata?.zukhrufTreeId, 'root-cas');
});

test('a child must point to the immediate ancestor of its canonical path', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  t.after(() => {
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
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: {} as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );

  await assert.rejects(
    runtime.enqueue(
      { chatId: 'skips-parent', userId: 'user-1' },
      { id: 'must-not-skip-parent', input: 'hello' },
    ),
    /invalid Zukhruf parent for chat "skips-parent"/,
  );
  assert.equal(queue.turns.length, 0);
});

test('host delivery rejects a recipient that does not own the stored chat', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  await store.upsertChat({ id: 'shared-chat', userId: 'alice' });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: {} as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );
  const recipient = { chatId: 'shared-chat', userId: 'bob' };

  await assert.rejects(
    runtime.deliver(
      createInterAgentCommunication({
        author: { chatId: 'sender', userId: 'alice' },
        recipient,
        content: 'poison mail',
      }),
      MessageDeliveryMode.TriggerTurn,
    ),
    /chat "shared-chat" belongs to user "alice", not "bob"/,
  );
  assert.equal(await mailboxStore.hasPending(recipient), false);
  assert.equal(queue.turns.length, 0);
});

test('explicit cancellation rejects a conversation that does not own the stored chat', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  await store.upsertChat({ id: 'shared-chat', userId: 'alice' });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: {} as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );
  const alice = await runtime.enqueue(
    { chatId: 'shared-chat', userId: 'alice' },
    { id: 'alice-turn', input: 'hello' },
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
  const queue = new RecordingTurnQueue();
  const sandboxStarted = Promise.withResolvers<void>();
  const releaseSandbox = Promise.withResolvers<void>();
  let modelCalls = 0;
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const runtime = new AgentRuntime(
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
      }) as AgentModel,
      sandbox: async () => {
        sandboxStarted.resolve();
        await releaseSandbox.promise;
        return {} as AgentSandbox;
      },
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );
  const conversation = { chatId: 'cancel-setup', userId: 'user-1' };
  const enqueued = await runtime.enqueue(conversation, {
    id: 'cancel-during-sandbox',
    input: 'never sample this',
  });
  await using _worker = await runtime.work();
  const running = queue.runNext();
  await sandboxStarted.promise;

  await runtime.observe(conversation).cancel(enqueued.id);
  releaseSandbox.resolve();
  await running;
  await sleep(25);

  assert.equal(await streamStore.getStreamStatus(enqueued.id), 'cancelled');
  assert.equal(modelCalls, 0);
});

test('cancellation that wins the execution claim prevents model sampling', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new CancelAfterStatusReadStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  let modelCalls = 0;
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const runtime = new AgentRuntime(
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
      }) as AgentModel,
      sandbox: async () => {
        streamStore.arm();
        return {} as AgentSandbox;
      },
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );
  const conversation = { chatId: 'cancel-claim', userId: 'user-1' };
  const enqueued = await runtime.enqueue(conversation, {
    id: 'cancel-before-claim',
    input: 'never sample this either',
  });

  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(await streamStore.getStreamStatus(enqueued.id), 'cancelled');
  assert.equal(modelCalls, 0);
});

test('cancellation after execution claim aborts pending provider setup', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new RecordingTurnQueue();
  const providerStarted = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<void>();
  let providerSignal: AbortSignal | undefined;
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const runtime = new AgentRuntime(
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
      }) as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streams: streamsFor(streamStore), mailboxStore, queue },
  );
  const conversation = { chatId: 'cancel-provider', userId: 'user-1' };
  const enqueued = await runtime.enqueue(conversation, {
    id: 'cancel-pending-provider',
    input: 'start slowly',
  });
  await using _worker = await runtime.work();
  const running = queue.runNext();
  await providerStarted.promise;

  await runtime.observe(conversation).cancel(enqueued.id);
  await sleep(25);
  const aborted = providerSignal?.aborted;
  releaseProvider.resolve();
  await running;

  assert.equal(aborted, true);
  assert.equal(await streamStore.getStreamStatus(enqueued.id), 'cancelled');
});
