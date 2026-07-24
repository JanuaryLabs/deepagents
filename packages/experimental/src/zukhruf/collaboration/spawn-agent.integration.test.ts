import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type AgentSandbox,
  InMemoryContextStore,
  SqliteStreamStore,
} from '@deepagents/context';
import {
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  SqliteMailboxStore,
  TurnQueue,
  type TurnRef,
  defineAgent,
} from '@deepagents/experimental/zukhruf';

class ControlledTurnQueue extends TurnQueue {
  readonly turns: TurnRef[] = [];
  readonly attemptedTurns: TurnRef[] = [];
  failNextChildPush = false;
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;

  override async push(turn: TurnRef) {
    this.attemptedTurns.push(turn);
    if (this.failNextChildPush && turn.chatId !== 'root-chat') {
      this.failNextChildPush = false;
      throw new Error('queue unavailable');
    }
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

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

function textResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'text-1' },
        { type: 'text-delta' as const, id: 'text-1', delta: text },
        { type: 'text-end' as const, id: 'text-1' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: '' },
          usage,
        },
      ],
    }),
  };
}

function agentPath(metadata: Record<string, unknown> | undefined) {
  const zukhruf = metadata?.zukhruf;
  return typeof zukhruf === 'object' && zukhruf !== null && 'path' in zukhruf
    ? zukhruf.path
    : undefined;
}

test('concurrent identical spawn_agent calls reserve one canonical child path', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let rootCalls = 0;
  const rootModel = new MockLanguageModelV4({
    doStream: async () => {
      rootCalls++;
      if (rootCalls === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'spawn-1',
                toolName: 'spawn_agent',
                input: JSON.stringify({
                  agent_type: 'worker',
                  task_name: 'same',
                  message: 'Do the work',
                }),
              },
              {
                type: 'tool-call',
                toolCallId: 'spawn-2',
                toolName: 'spawn_agent',
                input: JSON.stringify({
                  agent_type: 'worker',
                  task_name: 'same',
                  message: 'Do the work',
                }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: '' },
                usage,
              },
            ],
          }),
        };
      }
      return textResponse('spawns submitted');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const worker = defineAgent({
    name: 'worker',
    model: new MockLanguageModelV4({
      doStream: async () => textResponse('done'),
    }),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [worker],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    queue,
  });

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'Spawn the worker twice concurrently' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  const tree = await store.listChats({
    userId: 'user-1',
    metadata: { key: 'zukhrufTreeId', value: 'root-chat' },
  });
  const children = tree.filter(
    (chat) => agentPath(chat.metadata) === '/root/same',
  );
  assert.equal(children.length, 1);
});

test('spawn_agent retries an enqueue gap but does not restart a completed child path', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  queue.failNextChildPush = true;
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let rootCalls = 0;
  const rootModel = new MockLanguageModelV4({
    doStream: async () => {
      rootCalls++;
      if (rootCalls % 2 === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: `spawn-${rootCalls}`,
                toolName: 'spawn_agent',
                input: JSON.stringify({
                  agent_type: 'worker',
                  task_name: 'retryable',
                  message: 'Do the work',
                }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: '' },
                usage,
              },
            ],
          }),
        };
      }
      return textResponse('spawn submitted');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const worker = defineAgent({
    name: 'worker',
    model: new MockLanguageModelV4({
      doStream: async () => textResponse('done'),
    }),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [worker],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    queue,
  });
  await using _worker = await runtime.work();

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn-1', input: 'Spawn the worker' },
  );
  await queue.runNext();
  assert.equal(queue.turns.length, 0, 'the first child enqueue failed');

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn-2', input: 'Retry spawning the same worker' },
  );
  await queue.runNext();

  assert.equal(queue.turns.length, 1);
  assert.equal(queue.turns[0]?.kind, 'ask');
  const childAttempts = queue.attemptedTurns.filter(
    (turn) => turn.chatId !== 'root-chat',
  );
  assert.equal(childAttempts.length, 2);
  assert.equal(childAttempts[0]?.chatId, childAttempts[1]?.chatId);
  assert.equal(childAttempts[0]?.streamId, childAttempts[1]?.streamId);
  const tree = await store.listChats({
    userId: 'user-1',
    metadata: { key: 'zukhrufTreeId', value: 'root-chat' },
  });
  assert.equal(
    tree.filter((chat) => agentPath(chat.metadata) === '/root/retryable')
      .length,
    1,
  );

  await queue.runNext();
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn-3', input: 'Spawn the completed path again' },
  );
  await queue.runNext();

  assert.equal(
    queue.attemptedTurns.filter((turn) => turn.chatId !== 'root-chat').length,
    2,
    'a terminal child path must not silently queue its spent initial turn again',
  );
});
