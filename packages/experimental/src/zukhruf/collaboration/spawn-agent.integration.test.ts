import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  AgentRuntime,
  SqliteMailboxStore,
  type TurnRef,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { ControlledTurnQueue } from '../../testing/controlled-turn-queue.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { usage } from '../../testing/usage.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

class ChildFaultTurnQueue extends ControlledTurnQueue {
  readonly attemptedTurns: TurnRef[] = [];
  readonly childPushFaults: Error[] = [];

  override async push(turn: TurnRef) {
    this.attemptedTurns.push(turn);
    if (turn.chatId !== 'root-chat') {
      const fault = this.childPushFaults.shift();
      if (fault) throw fault;
    }
    await super.push(turn);
  }
}

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

test('concurrent identical spawn_agent calls reserve one canonical child path', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ChildFaultTurnQueue();
  using stores = new DisposableStack();
  stores.defer(() => {
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
                  fork_turns: 'all',
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
                  fork_turns: 'all',
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
  const sandbox = buildSandbox;
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
  const runtimeSetup = new AgentRuntime(root);
  const runtimeStack = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack);

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    userTurn('root-turn', 'Spawn the worker twice concurrently'),
  );
  await using _worker = await runtime.work();
  void _worker;
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

test('spawn_agent retries an enqueue gap but does not restart a completed child path', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ChildFaultTurnQueue();
  queue.childPushFaults.push(new Error('queue unavailable'));
  using stores = new DisposableStack();
  stores.defer(() => {
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
                  fork_turns: 'all',
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
  const sandbox = buildSandbox;
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
  const runtimeSetup = new AgentRuntime(root);
  const runtimeStack2 = defineStack(async () => ({
    store,
    streams: streamsFor(streamStore),
    mailboxStore,
    queue,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack2);
  await using _worker = await runtime.work();
  void _worker;

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    userTurn('root-turn-1', 'Spawn the worker'),
  );
  await queue.runNext();
  assert.equal(queue.turns.length, 0, 'the first child enqueue failed');

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    userTurn('root-turn-2', 'Retry spawning the same worker'),
  );
  await queue.runNext();

  assert.equal(queue.turns.length, 1);
  assert.equal(queue.turns[0]?.kind, 'message');
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
    userTurn('root-turn-3', 'Spawn the completed path again'),
  );
  await queue.runNext();

  assert.equal(
    queue.attemptedTurns.filter((turn) => turn.chatId !== 'root-chat').length,
    2,
    'a terminal child path must not silently queue its spent initial turn again',
  );
});
