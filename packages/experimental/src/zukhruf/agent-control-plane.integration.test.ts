import { isToolUIPart, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  type AgentSandbox,
  InMemoryContextStore,
  SqliteStreamStore,
} from '@deepagents/context';
import {
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  type ConversationId,
  type InterAgentCommunication,
  type MailboxEnqueueResult,
  MessageDeliveryMode,
  SqliteApprovalMutex,
  SqliteMailboxStore,
  TurnQueue,
  type TurnRef,
  createInterAgentCommunication,
  defineAgent,
  defineTool,
} from '@deepagents/experimental/zukhruf';

const approvalMutex = new SqliteApprovalMutex(':memory:');

async function settleWithin<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(new Error(`timed out waiting for: ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}

class ControlledTurnQueue extends TurnQueue {
  readonly turns: TurnRef[] = [];
  resumeCalls = 0;
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
  #options?: ConsumeOptions;

  override async push(turn: TurnRef): Promise<void> {
    this.turns.push(turn);
  }

  override async consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    _options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    this.#handler = handler;
    this.#options = _options;
    return {
      [Symbol.asyncDispose]: async () => {
        this.#handler = undefined;
        this.#options = undefined;
      },
    };
  }

  override async resumeParked(): Promise<void> {
    this.resumeCalls++;
  }

  override async getTurnActivity(
    conversation: ConversationId,
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
    conversation: ConversationId,
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

  async runNext(): Promise<void> {
    const turn = this.turns.shift();
    assert.ok(turn, 'expected a queued turn');
    await this.#run(turn);
  }

  async runNextFor(chatId: string): Promise<void> {
    const index = this.turns.findIndex((turn) => turn.chatId === chatId);
    assert.notEqual(index, -1, `expected a queued turn for ${chatId}`);
    const [turn] = this.turns.splice(index, 1);
    assert.ok(turn);
    await this.#run(turn);
  }

  async retryOrphan(turn: TurnRef, error: string): Promise<void> {
    assert.ok(this.#options, 'expected consumer options');
    await this.#options.onOrphaned(turn, error);
  }

  async #run(turn: TurnRef): Promise<void> {
    assert.ok(this.#handler, 'expected a running worker');
    try {
      await this.#handler(turn, {
        signal: new AbortController().signal,
        park: async () => {
          throw new Error('turn unexpectedly parked');
        },
      });
    } catch (error) {
      assert.ok(this.#options, 'expected consumer options');
      await this.#options.onOrphaned(
        turn,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

class SharedTurnQueueState {
  readonly turns: TurnRef[] = [];
  readonly running = new Map<
    string,
    { turn: TurnRef; abort: AbortController; owner: symbol }
  >();
}

class SharedControlledTurnQueue extends TurnQueue {
  readonly #state: SharedTurnQueueState;
  readonly #owner = Symbol('shared-turn-queue-owner');
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
  #options?: ConsumeOptions;

  constructor(state: SharedTurnQueueState) {
    super();
    this.#state = state;
  }

  override async push(turn: TurnRef): Promise<void> {
    this.#state.turns.push(turn);
  }

  override async consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    this.#handler = handler;
    this.#options = options;
    return {
      [Symbol.asyncDispose]: async () => {
        this.#handler = undefined;
        this.#options = undefined;
      },
    };
  }

  override async resumeParked(): Promise<void> {}

  override async getTurnActivity(
    conversation: ConversationId,
  ): Promise<'idle' | 'queued' | 'running'> {
    const key = SharedControlledTurnQueue.#key(conversation);
    if (this.#state.running.has(key)) return 'running';
    return this.#state.turns.some(
      (turn) => SharedControlledTurnQueue.#key(turn) === key,
    )
      ? 'queued'
      : 'idle';
  }

  override async getCurrentTurn(
    conversation: ConversationId,
  ): Promise<TurnRef | undefined> {
    const key = SharedControlledTurnQueue.#key(conversation);
    return (
      this.#state.running.get(key)?.turn ??
      this.#state.turns.find(
        (turn) => SharedControlledTurnQueue.#key(turn) === key,
      )
    );
  }

  override async cancel(streamId: string): Promise<void> {
    for (const active of this.#state.running.values()) {
      if (active.owner === this.#owner && active.turn.streamId === streamId) {
        active.abort.abort();
      }
    }
    const remaining = this.#state.turns.filter(
      (turn) => turn.streamId !== streamId,
    );
    this.#state.turns.splice(0, this.#state.turns.length, ...remaining);
  }

  async runNextFor(chatId: string): Promise<void> {
    const index = this.#state.turns.findIndex((turn) => turn.chatId === chatId);
    assert.notEqual(index, -1, `expected a queued turn for ${chatId}`);
    const [turn] = this.#state.turns.splice(index, 1);
    assert.ok(turn);
    assert.ok(this.#handler, 'expected a running worker');
    assert.ok(this.#options, 'expected consumer options');

    const key = SharedControlledTurnQueue.#key(turn);
    const abort = new AbortController();
    this.#state.running.set(key, { turn, abort, owner: this.#owner });
    try {
      await this.#handler(turn, {
        signal: abort.signal,
        park: async () => {
          throw new Error('turn unexpectedly parked');
        },
      });
    } catch (error) {
      await this.#options.onOrphaned(
        turn,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.#state.running.delete(key);
    }
  }

  static #key(conversation: ConversationId): string {
    return JSON.stringify([conversation.chatId, conversation.userId]);
  }
}

class FailFirstMailboxEnqueueStore extends SqliteMailboxStore {
  #fail = true;

  override async enqueue(
    communication: InterAgentCommunication,
  ): Promise<MailboxEnqueueResult> {
    if (this.#fail) {
      this.#fail = false;
      throw new Error('simulated completion mailbox failure');
    }
    return super.enqueue(communication);
  }
}

class FailTwiceMailboxEnqueueStore extends SqliteMailboxStore {
  #failuresRemaining = 2;

  override async enqueue(
    communication: InterAgentCommunication,
  ): Promise<MailboxEnqueueResult> {
    if (this.#failuresRemaining > 0) {
      this.#failuresRemaining--;
      throw new Error('simulated repeated completion mailbox failure');
    }
    return super.enqueue(communication);
  }
}

class DelayedStaleLatestTurnStore extends InMemoryContextStore {
  readonly staleWriteStarted = Promise.withResolvers<void>();
  readonly #releaseStaleWrite = Promise.withResolvers<void>();
  #staleTurnId?: string;

  arm(staleTurnId: string): void {
    this.#staleTurnId = staleTurnId;
  }

  release(): void {
    this.#releaseStaleWrite.resolve();
  }

  override async updateChat(
    chatId: string,
    update: Parameters<InMemoryContextStore['updateChat']>[1],
  ) {
    await this.#pauseIfStale();
    return super.updateChat(chatId, update);
  }

  async #pauseIfStale() {
    if (this.#staleTurnId === undefined) return;
    this.#staleTurnId = undefined;
    this.staleWriteStarted.resolve();
    await this.#releaseStaleWrite.promise;
  }
}

class FailFirstMailboxBeginStore extends SqliteMailboxStore {
  #fail = true;

  override async beginTurn(
    recipient: ConversationId,
    turnId: string,
  ): Promise<void> {
    if (this.#fail) {
      this.#fail = false;
      throw new Error('simulated mailbox setup failure');
    }
    return super.beginTurn(recipient, turnId);
  }
}

class CommitThenFailFirstMailboxStore extends SqliteMailboxStore {
  #fail = true;

  override async enqueue(
    communication: InterAgentCommunication,
  ): Promise<MailboxEnqueueResult> {
    const result = await super.enqueue(communication);
    if (this.#fail) {
      this.#fail = false;
      throw new Error('simulated crash after mailbox commit');
    }
    return result;
  }
}

class WaitObservedMailboxStore extends SqliteMailboxStore {
  readonly pendingChecked = Promise.withResolvers<void>();

  override async hasPending(recipient: ConversationId): Promise<boolean> {
    this.pendingChecked.resolve();
    return super.hasPending(recipient);
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

function textModel(text: string, calls: unknown[]) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      calls.push(prompt);
      return textResponse(text);
    },
  });
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

async function createAgentChats(
  store: InMemoryContextStore,
  chats: Array<{
    id: string;
    path: string;
    parentChatId: string | null;
    declarationName: string;
  }>,
): Promise<void> {
  for (const chat of chats) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }
}

function toolCallResponse(
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId,
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: '' },
          usage,
        },
      ],
    }),
  };
}

function listAgentsModel(capturedPrompts: unknown[]) {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      calls++;
      if (calls === 1) {
        return toolCallResponse('list_agents', 'list-terminal-status', {});
      }
      capturedPrompts.push(prompt);
      return textResponse('terminal status listed');
    },
  });
}

test('worker dispatches a child chat to the declaration named by its metadata', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const rootCalls: unknown[] = [];
  const childCalls: unknown[] = [];
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('child reply', childCalls),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: textModel('root reply', rootCalls),
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
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
    id: 'child-chat',
    userId: 'user-1',
    metadata: {
      zukhrufTreeId: 'root-chat',
      zukhruf: {
        path: '/root/researcher',
        parentChatId: 'root-chat',
        declarationName: 'researcher',
      },
    },
  });

  await runtime.enqueue(
    { chatId: 'child-chat', userId: 'user-1' },
    { id: 'child-turn', input: 'research this' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(rootCalls.length, 0);
  assert.equal(childCalls.length, 1);
  const head = (
    await runtime
      .observe({
        chatId: 'child-chat',
        userId: 'user-1',
      })
      .engine.getMessages()
  ).at(-1);
  assert.equal(head?.role, 'assistant');
  assert.equal(
    head?.parts.find((part) => part.type === 'text')?.text,
    'child reply',
  );
});

test('a terminal duplicate cannot replace a newer latest turn', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const modelCalls: unknown[] = [];
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: textModel('done', modelCalls),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    { store, streamStore, mailboxStore, queue, approvalMutex },
  );
  const conversation = { chatId: 'root-chat', userId: 'user-1' };
  const first = await runtime.enqueue(conversation, {
    id: 'caller-turn-a',
    input: 'first',
  });
  await using _worker = await runtime.work();
  await queue.runNext();
  const second = await runtime.enqueue(conversation, {
    id: 'caller-turn-b',
    input: 'second',
  });
  await queue.runNext();
  const duplicate = await runtime.enqueue(conversation, {
    id: 'caller-turn-a',
    input: 'must not run again',
  });
  assert.equal(duplicate.id, first.id);
  await queue.runNext();

  const chat = await store.getChat(conversation.chatId);
  const metadata = chat?.metadata as
    | { zukhruf?: { lastTurnId?: string } }
    | undefined;
  assert.equal(metadata?.zukhruf?.lastTurnId, second.id);
  assert.equal(modelCalls.length, 2);
});

test('spawn_agent queues an independent child turn and returns before it runs', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let rootCalls = 0;
  let promptAfterSpawn: unknown;
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
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
                  agent_type: ' researcher ',
                  task_name: ' market_research ',
                  message: 'Research the market',
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
      promptAfterSpawn = prompt;
      return textResponse('parent continues');
    },
  });
  const childCalls: unknown[] = [];
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('research complete', childCalls),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'Delegate this research' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(rootCalls, 2);
  assert.equal(childCalls.length, 0);
  assert.equal(queue.turns.length, 1);
  const childTurn = queue.turns[0];
  assert.ok(childTurn && childTurn.kind === 'ask');
  assert.notEqual(childTurn.chatId, 'root-chat');
  assert.equal(childTurn.userId, 'user-1');
  assert.equal(childTurn.input, 'Research the market');
  assert.match(JSON.stringify(promptAfterSpawn), /\/root\/market_research/);

  const childChat = await store.getChat(childTurn.chatId);
  assert.equal(childChat?.metadata?.zukhrufTreeId, 'root-chat');
  const childMetadata = childChat?.metadata?.zukhruf as
    | {
        path?: string;
        parentChatId?: string;
        declarationName?: string;
        historyFork?: {
          forkTurns?: string;
          parentChatId?: string;
          parentHeadMessageId?: string;
          sourceMessageIds?: string[];
        };
      }
    | undefined;
  assert.equal(childMetadata?.path, '/root/market_research');
  assert.equal(childMetadata?.parentChatId, 'root-chat');
  assert.equal(childMetadata?.declarationName, 'researcher');
  assert.equal(childMetadata?.historyFork?.forkTurns, 'all');
  assert.equal(childMetadata?.historyFork?.parentChatId, 'root-chat');
  assert.equal(
    typeof childMetadata?.historyFork?.parentHeadMessageId,
    'string',
  );
  assert.equal(childMetadata?.historyFork?.sourceMessageIds?.length, 1);

  await queue.runNext();
  assert.equal(childCalls.length, 1);
});

test('a completed child queues its final answer to the parent without waking it', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('research complete', []),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: textModel('root reply', []),
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
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
    id: 'child-chat',
    userId: 'user-1',
    metadata: {
      zukhrufTreeId: 'root-chat',
      zukhruf: {
        path: '/root/research',
        parentChatId: 'root-chat',
        declarationName: 'researcher',
      },
    },
  });

  await runtime.enqueue(
    { chatId: 'child-chat', userId: 'user-1' },
    { id: 'child-turn', input: 'Research this' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(queue.turns.length, 0, 'completion is queue-only');
  const completion = (
    await mailboxStore.drain({ chatId: 'root-chat', userId: 'user-1' })
  )[0] as
    | {
        type?: string;
        author: { chatId: string };
        recipient: { chatId: string };
        content: string;
        triggerTurn: boolean;
      }
    | undefined;
  assert.ok(completion);
  assert.equal(completion.type, 'FINAL_ANSWER');
  assert.equal(completion.author.chatId, 'child-chat');
  assert.equal(completion.recipient.chatId, 'root-chat');
  assert.equal(completion.content, 'research complete');
  assert.equal(completion.triggerTurn, false);
});

test('an approval-paused child sends one final answer only after continuation', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let childCalls = 0;
  let rootCalls = 0;
  let listedPrompt: unknown;
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: new MockLanguageModelV4({
      doStream: async () => {
        childCalls++;
        return childCalls === 1
          ? toolCallResponse('publish', 'publish-report', {
              report: 'research complete',
            })
          : textResponse('published research complete');
      },
    }),
    sandbox,
    instructions: [],
    tools: {
      publish: defineTool({
        description: 'Publish the completed report',
        inputSchema: z.object({ report: z.string() }),
        needsApproval: true,
        execute: async ({ report }) => report,
      }),
    },
  });
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      rootCalls++;
      if (rootCalls === 1) {
        return toolCallResponse('list_agents', 'list-paused-child', {});
      }
      listedPrompt = prompt;
      return textResponse('listed paused child');
    },
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: rootModel,
      sandbox,
      instructions: [],
      subagents: [researcher],
    }),
    { store, streamStore, mailboxStore, queue, approvalMutex },
  );
  await createAgentChats(store, [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'paused-child-chat',
      path: '/root/research',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]);

  await runtime.enqueue(
    { chatId: 'paused-child-chat', userId: 'user-1' },
    { id: 'paused-child-turn', input: 'Research and publish' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.deepStrictEqual(
    await mailboxStore.drain({ chatId: 'root-chat', userId: 'user-1' }),
    [],
    'an approval pause is not terminal delivery',
  );
  const paused = (
    await runtime
      .observe({ chatId: 'paused-child-chat', userId: 'user-1' })
      .engine.getMessages()
  ).at(-1)!;
  const toolPart = paused.parts.find(isToolUIPart);
  assert.equal(toolPart?.state, 'approval-requested');

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'list-paused-turn', input: 'List the agents' },
  );
  await queue.runNext();
  assert.match(JSON.stringify(listedPrompt), /"agent_status":"running"/);
  assert.doesNotMatch(JSON.stringify(listedPrompt), /waiting_approval/);

  await runtime.approve(
    { chatId: 'paused-child-chat', userId: 'user-1' },
    { toolCallId: 'publish-report' },
  );
  await queue.runNext();
  const completions = await mailboxStore.drain({
    chatId: 'root-chat',
    userId: 'user-1',
  });
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.type, 'FINAL_ANSWER');
  assert.equal(completions[0]?.content, 'published research complete');
});

test('a failed approval continuation reports failure instead of remaining paused', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let sandboxCalls = 0;
  let researcherCalls = 0;
  const listedPrompts: unknown[] = [];
  const researcher = defineAgent({
    name: 'researcher',
    model: new MockLanguageModelV4({
      doStream: async () => {
        researcherCalls++;
        return researcherCalls === 1
          ? toolCallResponse('publish', 'failed-publish', {
              report: 'research complete',
            })
          : textResponse('recovered after failed continuation');
      },
    }),
    sandbox: async () => {
      sandboxCalls++;
      if (sandboxCalls === 2) {
        throw new Error('continuation sandbox exploded');
      }
      return {} as AgentSandbox;
    },
    instructions: [],
    tools: {
      publish: defineTool({
        description: 'Publish the completed report',
        inputSchema: z.object({ report: z.string() }),
        needsApproval: true,
        execute: async ({ report }) => report,
      }),
    },
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: listAgentsModel(listedPrompts),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      subagents: [researcher],
    }),
    { store, streamStore, mailboxStore, queue, approvalMutex },
  );
  await createAgentChats(store, [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'failed-continuation-child',
      path: '/root/research',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]);

  const childConversation = {
    chatId: 'failed-continuation-child',
    userId: 'user-1',
  };
  const initial = await runtime.enqueue(childConversation, {
    id: 'failed-continuation-turn',
    input: 'Research and publish',
  });
  await using _worker = await runtime.work();
  await queue.runNext();
  await runtime.approve(childConversation, { toolCallId: 'failed-publish' });
  const resumesBeforeFailure = queue.resumeCalls;
  await queue.runNext();

  assert.equal(await streamStore.getStreamStatus(initial.id), 'failed');
  assert.ok(queue.resumeCalls > resumesBeforeFailure);
  const failedMessage = (
    await runtime.observe(childConversation).engine.getMessages()
  ).find((message) => message.id === initial.id);
  assert.equal(failedMessage?.parts.find(isToolUIPart)?.state, 'output-error');
  const notifications = await mailboxStore.drain({
    chatId: 'root-chat',
    userId: 'user-1',
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, 'FINAL_ANSWER');
  assert.equal(
    notifications[0]?.content,
    'Agent failed: continuation sandbox exploded',
  );

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'list-failed-continuation', input: 'Inspect failed agents' },
  );
  await queue.runNext();
  assert.match(
    JSON.stringify(listedPrompts[0]),
    /"agent_status":\{"errored":"continuation sandbox exploded"\}/,
  );
  assert.doesNotMatch(JSON.stringify(listedPrompts[0]), /waiting_approval/);

  const recovery = await runtime.enqueue(childConversation, {
    id: 'recover-after-failed-continuation',
    input: 'Continue with a new request',
  });
  await queue.runNext();
  assert.equal(await streamStore.getStreamStatus(recovery.id), 'completed');
  assert.equal(researcherCalls, 2);
});

test('a cancelled approval continuation clears the gate and revives parked turns', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  const continuationSandboxStarted = Promise.withResolvers<void>();
  const releaseContinuationSandbox = Promise.withResolvers<void>();
  let sandboxCalls = 0;
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
          return modelCalls === 1
            ? toolCallResponse('publish', 'cancelled-publish', {
                report: 'ready',
              })
            : textResponse('new ask recovered');
        },
      }),
      sandbox: async () => {
        sandboxCalls++;
        if (sandboxCalls === 2) {
          continuationSandboxStarted.resolve();
          await releaseContinuationSandbox.promise;
        }
        return {} as AgentSandbox;
      },
      instructions: [],
      tools: {
        publish: defineTool({
          description: 'Publish a report',
          inputSchema: z.object({ report: z.string() }),
          needsApproval: true,
          execute: async ({ report }) => report,
        }),
      },
    }),
    { store, streamStore, mailboxStore, queue, approvalMutex },
  );
  const conversation = { chatId: 'cancelled-continuation', userId: 'user-1' };
  const initial = await runtime.enqueue(conversation, {
    id: 'cancelled-continuation-turn',
    input: 'publish after approval',
  });
  await using _worker = await runtime.work();
  await queue.runNext();
  await runtime.approve(conversation, { toolCallId: 'cancelled-publish' });
  const resumesBeforeCancellation = queue.resumeCalls;
  const continuation = queue.runNext();
  await continuationSandboxStarted.promise;

  await runtime.observe(conversation).cancel(initial.id);
  releaseContinuationSandbox.resolve();
  await continuation;

  const cancelledMessage = (
    await runtime.observe(conversation).engine.getMessages()
  ).find((message) => message.id === initial.id);
  assert.equal(
    cancelledMessage?.parts.find(isToolUIPart)?.state,
    'output-error',
  );
  assert.ok(queue.resumeCalls > resumesBeforeCancellation);

  const recovery = await runtime.enqueue(conversation, {
    id: 'after-cancelled-continuation',
    input: 'start a fresh ask',
  });
  await queue.runNext();
  assert.equal(await streamStore.getStreamStatus(recovery.id), 'completed');
  assert.equal(modelCalls, 2);
});

test('failed continuation preserves denied sibling semantics', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  let sandboxCalls = 0;
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });
  const inputSchema = z.object({ report: z.string() });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'approved-sibling',
                toolName: 'publish',
                input: JSON.stringify({ report: 'publish' }),
              },
              {
                type: 'tool-call',
                toolCallId: 'denied-sibling',
                toolName: 'archive',
                input: JSON.stringify({ report: 'archive' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: '' },
                usage,
              },
            ],
          }),
        }),
      }),
      sandbox: async () => {
        sandboxCalls++;
        if (sandboxCalls === 2) throw new Error('sibling continuation failed');
        return {} as AgentSandbox;
      },
      instructions: [],
      tools: {
        publish: defineTool({
          description: 'Publish',
          inputSchema,
          needsApproval: true,
          execute: async ({ report }) => report,
        }),
        archive: defineTool({
          description: 'Archive',
          inputSchema,
          needsApproval: true,
          execute: async ({ report }) => report,
        }),
      },
    }),
    { store, streamStore, mailboxStore, queue, approvalMutex },
  );
  const conversation = { chatId: 'failed-siblings', userId: 'user-1' };
  const initial = await runtime.enqueue(conversation, {
    id: 'failed-sibling-turn',
    input: 'run both tools',
  });
  await using _worker = await runtime.work();
  await queue.runNext();
  await runtime.approve(conversation, { toolCallId: 'approved-sibling' });
  await runtime.deny(conversation, { toolCallId: 'denied-sibling' });
  await queue.runNext();

  const message = (
    await runtime.observe(conversation).engine.getMessages()
  ).find((candidate) => candidate.id === initial.id);
  assert.deepStrictEqual(
    message?.parts.filter(isToolUIPart).map((part) => part.state),
    ['output-error', 'output-denied'],
  );
});

test('a terminal child completion survives a transient parent-mailbox failure', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new FailFirstMailboxEnqueueStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('durable result', []),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: textModel('root reply', []),
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
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
    id: 'child-chat',
    userId: 'user-1',
    metadata: {
      zukhrufTreeId: 'root-chat',
      zukhruf: {
        path: '/root/research',
        parentChatId: 'root-chat',
        declarationName: 'researcher',
      },
    },
  });

  const childTurn = await runtime.enqueue(
    { chatId: 'child-chat', userId: 'user-1' },
    { id: 'child-terminal-turn', input: 'Research durably' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(await streamStore.getStreamStatus(childTurn.id), 'completed');
  const completion = await mailboxStore.drain({
    chatId: 'root-chat',
    userId: 'user-1',
  });
  assert.equal(completion.length, 1);
  assert.equal(completion[0]?.type, 'FINAL_ANSWER');
  assert.equal(completion[0]?.content, 'durable result');
});

test('a stale orphan retry cannot clear or supersede a successor turn', async (t) => {
  const store = new DelayedStaleLatestTurnStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new FailTwiceMailboxEnqueueStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const successorStarted = Promise.withResolvers<void>();
  const releaseSuccessor = Promise.withResolvers<void>();
  let childCalls = 0;
  const researcher = defineAgent({
    name: 'researcher',
    model: new MockLanguageModelV4({
      doStream: async () => {
        childCalls++;
        if (childCalls === 1) return textResponse('old result');
        return {
          stream: new ReadableStream({
            async start(controller) {
              successorStarted.resolve();
              await releaseSuccessor.promise;
              controller.enqueue({
                type: 'text-start' as const,
                id: 'successor-text',
              });
              controller.enqueue({
                type: 'text-delta' as const,
                id: 'successor-text',
                delta: 'successor result',
              });
              controller.enqueue({
                type: 'text-end' as const,
                id: 'successor-text',
              });
              controller.enqueue({
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: '' },
                usage,
              });
              controller.close();
            },
          }),
        };
      },
    }),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: textModel('root reply', []),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      subagents: [researcher],
    }),
    { store, streamStore, mailboxStore, queue, approvalMutex },
  );
  await createAgentChats(store, [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'orphan-race-child',
      path: '/root/research',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]);

  const child = { chatId: 'orphan-race-child', userId: 'user-1' };
  await runtime.enqueue(child, {
    id: 'stale-orphan-turn',
    input: 'Produce the old result',
  });
  const staleTurn = queue.turns[0];
  assert.ok(staleTurn);
  await using _worker = await runtime.work();
  await assert.rejects(
    queue.runNext(),
    /simulated repeated completion mailbox failure/,
  );

  const storedChild = await store.getChat(child.chatId);
  assert.ok(storedChild?.metadata);
  const metadataWithoutLatest = structuredClone(storedChild.metadata) as {
    zukhruf: { lastTurnId?: string };
  };
  delete metadataWithoutLatest.zukhruf.lastTurnId;
  await store.updateChat(child.chatId, () => ({
    metadata: metadataWithoutLatest,
  }));

  store.arm(staleTurn.streamId);
  const staleRetry = queue.retryOrphan(
    staleTurn,
    'retry the stale orphan callback',
  );
  await store.staleWriteStarted.promise;
  const successorTurn = await runtime.enqueue(child, {
    id: 'successor-turn',
    input: 'Produce the successor result',
  });
  const successor = queue.runNext();
  await successorStarted.promise;
  try {
    store.release();
    await staleRetry;
    const staleProjection = await mailboxStore.drain({
      chatId: 'root-chat',
      userId: 'user-1',
    });
    assert.equal(staleProjection.length, 1);
    assert.equal(staleProjection[0]?.content, 'old result');
    await runtime.deliver(
      createInterAgentCommunication({
        author: { chatId: 'root-chat', userId: 'user-1' },
        recipient: child,
        content: 'mail while the successor is active',
      }),
      MessageDeliveryMode.QueueOnly,
    );

    const chat = await store.getChat(child.chatId);
    const metadata = chat?.metadata as
      | { zukhruf?: { lastTurnId?: string } }
      | undefined;
    assert.deepStrictEqual(
      {
        successorActivityPreserved: queue.turns.some(
          (turn) => turn.kind === 'mailbox' && turn.chatId === child.chatId,
        ),
        latestTurnId: metadata?.zukhruf?.lastTurnId,
      },
      {
        successorActivityPreserved: true,
        latestTurnId: successorTurn.id,
      },
    );
  } finally {
    releaseSuccessor.resolve();
    await successor;
  }
});

test('terminal child recovery does not duplicate a completion committed before a crash', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new CommitThenFailFirstMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('one durable result', []),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: textModel('root reply', []),
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  for (const chat of [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'child-chat',
      path: '/root/research',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }

  await runtime.enqueue(
    { chatId: 'child-chat', userId: 'user-1' },
    { id: 'idempotent-child-turn', input: 'Research once' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  const completions = await mailboxStore.drain({
    chatId: 'root-chat',
    userId: 'user-1',
  });
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.type, 'FINAL_ANSWER');
  assert.equal(completions[0]?.content, 'one durable result');
});

test('a failed child asynchronously notifies its parent with the terminal status', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const sandbox = async () => ({}) as AgentSandbox;
  const failedListPrompts: unknown[] = [];
  const researcher = defineAgent({
    name: 'researcher',
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.error(new Error('child model exploded'));
          },
        }),
      }),
    }),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: listAgentsModel(failedListPrompts),
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  for (const chat of [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'failed-child-chat',
      path: '/root/research',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }

  const failedTurn = await runtime.enqueue(
    { chatId: 'failed-child-chat', userId: 'user-1' },
    { id: 'failed-child-turn', input: 'Run the risky research' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(await streamStore.getStreamStatus(failedTurn.id), 'failed');
  const notifications = await mailboxStore.drain({
    chatId: 'root-chat',
    userId: 'user-1',
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, 'FINAL_ANSWER');
  assert.equal(notifications[0]?.metadata?.status, 'failed');
  assert.equal(notifications[0]?.content, 'Agent failed: An error occurred.');

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'list-failed-child', input: 'Inspect failed agents' },
  );
  await queue.runNext();
  assert.match(
    JSON.stringify(failedListPrompts[0]),
    /"agent_status":\{"errored":"An error occurred\."\}/,
  );
});

test('list_agents reports a child whose turn fails before setup completes', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new FailFirstMailboxBeginStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const childCalls: unknown[] = [];
  const listedPrompts: unknown[] = [];
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('must not run', childCalls),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: listAgentsModel(listedPrompts),
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  for (const chat of [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'setup-failed-child',
      path: '/root/research',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }

  const failedTurn = await runtime.enqueue(
    { chatId: 'setup-failed-child', userId: 'user-1' },
    { id: 'setup-failed-turn', input: 'Start the child' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(childCalls.length, 0);
  assert.equal(await streamStore.getStreamStatus(failedTurn.id), 'failed');

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'list-setup-failed-child', input: 'Inspect failed agents' },
  );
  await queue.runNext();
  assert.match(
    JSON.stringify(listedPrompts[0]),
    /"agent_status":\{"errored":"simulated mailbox setup failure"\}/,
  );
});

test('a cancelled child asynchronously notifies its parent with the terminal status', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const samplingStarted = Promise.withResolvers<void>();
  const cancelledListPrompts: unknown[] = [];
  const researcher = defineAgent({
    name: 'researcher',
    model: new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start() {
            samplingStarted.resolve();
          },
        }),
      }),
    }),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: listAgentsModel(cancelledListPrompts),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  for (const chat of [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'cancelled-child-chat',
      path: '/root/research',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }

  const cancelledTurn = await runtime.enqueue(
    { chatId: 'cancelled-child-chat', userId: 'user-1' },
    { id: 'cancelled-child-turn', input: 'Start long research' },
  );
  await using _worker = await runtime.work();
  const executing = queue.runNext();
  await samplingStarted.promise;
  await runtime
    .observe({ chatId: 'cancelled-child-chat', userId: 'user-1' })
    .cancel(cancelledTurn.id);
  await executing;

  assert.equal(
    await streamStore.getStreamStatus(cancelledTurn.id),
    'cancelled',
  );
  const notifications = await mailboxStore.drain({
    chatId: 'root-chat',
    userId: 'user-1',
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, 'FINAL_ANSWER');
  assert.equal(notifications[0]?.metadata?.status, 'cancelled');
  assert.equal(notifications[0]?.content, 'Agent was interrupted.');

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'list-cancelled-child', input: 'Inspect interrupted agents' },
  );
  await queue.runNext();
  assert.match(
    JSON.stringify(cancelledListPrompts[0]),
    /"agent_status":"interrupted"/,
  );
});

test('a child cancelled while queued notifies its parent once without running the model', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const childCalls: unknown[] = [];
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('must not run', childCalls),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: textModel('root reply', []),
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });
  for (const chat of [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'queued-child-chat',
      path: '/root/research',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }

  const conversation = { chatId: 'queued-child-chat', userId: 'user-1' };
  const turn = { id: 'cancelled-before-start', input: 'Never start this' };
  const cancelledTurn = await runtime.enqueue(conversation, turn);
  await runtime.observe(conversation).cancel(cancelledTurn.id);
  await runtime.enqueue(conversation, turn);

  await using _worker = await runtime.work();
  await queue.runNext();
  await queue.runNext();

  assert.equal(childCalls.length, 0);
  const notifications = await mailboxStore.drain({
    chatId: 'root-chat',
    userId: 'user-1',
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.metadata?.status, 'cancelled');
  assert.equal(notifications[0]?.content, 'Agent was interrupted.');
});

test('send_message resolves a canonical sibling path and queues mail without waking it', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let senderCalls = 0;
  const senderModel = new MockLanguageModelV4({
    doStream: async () => {
      senderCalls++;
      if (senderCalls === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'send-1',
                toolName: 'send_message',
                input: JSON.stringify({
                  target: '/root/reviewer',
                  message: 'Check this conclusion',
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
      return textResponse('message sent');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const sender = defineAgent({
    name: 'sender',
    model: senderModel,
    sandbox,
    instructions: [],
  });
  const reviewer = defineAgent({
    name: 'reviewer',
    model: textModel('reviewed', []),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: textModel('root reply', []),
    sandbox,
    instructions: [],
    subagents: [sender, reviewer],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  for (const chat of [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'sender-chat',
      path: '/root/sender',
      parentChatId: 'root-chat',
      declarationName: 'sender',
    },
    {
      id: 'reviewer-chat',
      path: '/root/reviewer',
      parentChatId: 'root-chat',
      declarationName: 'reviewer',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }

  await runtime.enqueue(
    { chatId: 'sender-chat', userId: 'user-1' },
    { id: 'sender-turn', input: 'Send the review request' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(senderCalls, 2);
  assert.equal(queue.turns.length, 0, 'send_message does not wake the target');
  const messages = await mailboxStore.drain({
    chatId: 'reviewer-chat',
    userId: 'user-1',
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, 'MESSAGE');
  assert.equal(messages[0]?.author.chatId, 'sender-chat');
  assert.equal(messages[0]?.recipient.chatId, 'reviewer-chat');
  assert.equal(messages[0]?.content, 'Check this conclusion');
  assert.equal(messages[0]?.triggerTurn, false);
  assert.deepEqual(messages[0]?.metadata, {
    authorPath: '/root/sender',
    recipientPath: '/root/reviewer',
  });
});

test('followup_task wakes a non-root target with a new task', async (t) => {
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
                toolCallId: 'followup-1',
                toolName: 'followup_task',
                input: JSON.stringify({
                  target: '/root/researcher',
                  message: 'Verify the edge case',
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
      return textResponse('follow-up assigned');
    },
  });
  const researcherCalls: unknown[] = [];
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('follow-up complete', researcherCalls),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  for (const chat of [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'researcher-chat',
      path: '/root/researcher',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'Assign follow-up work' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(rootCalls, 2);
  assert.equal(researcherCalls.length, 0);
  assert.equal(queue.turns.length, 1);
  assert.equal(queue.turns[0]?.kind, 'mailbox');
  assert.equal(queue.turns[0]?.chatId, 'researcher-chat');

  await queue.runNext();
  assert.equal(researcherCalls.length, 1);
  const prompt = JSON.stringify(researcherCalls[0]);
  assert.match(prompt, /Message Type: NEW_TASK/);
  assert.match(prompt, /Sender: \/root/);
  assert.match(prompt, /Verify the edge case/);
  assert.equal(queue.turns.length, 0);

  const completion = await mailboxStore.drain({
    chatId: 'root-chat',
    userId: 'user-1',
  });
  assert.equal(completion.length, 1);
  assert.equal(completion[0]?.type, 'FINAL_ANSWER');
  assert.equal(completion[0]?.content, 'follow-up complete');
});

test('interrupt_agent cancels the oldest queued child turn and reports its prior status', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let rootCalls = 0;
  let promptAfterInterrupt: unknown;
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      rootCalls++;
      if (rootCalls === 1) {
        return toolCallResponse('interrupt_agent', 'interrupt-child', {
          target: '/root/researcher',
        });
      }
      if (rootCalls === 2) {
        return toolCallResponse('list_agents', 'list-interrupted-child', {});
      }
      if (rootCalls === 4) {
        return toolCallResponse('followup_task', 'reuse-child', {
          target: '/root/researcher',
          message: 'Start a fresh task',
        });
      }
      if (rootCalls === 3) promptAfterInterrupt = prompt;
      return textResponse('child interrupted');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const researcherCalls: unknown[] = [];
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('fresh task complete', researcherCalls),
    sandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: rootModel,
      sandbox,
      instructions: [],
      subagents: [researcher],
    }),
    { store, streamStore, mailboxStore, queue, approvalMutex },
  );
  await createAgentChats(store, [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'researcher-chat',
      path: '/root/researcher',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]);

  const child = await runtime.enqueue(
    { chatId: 'researcher-chat', userId: 'user-1' },
    { id: 'child-turn', input: 'research this' },
  );
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'stop the child' },
  );
  await using _worker = await runtime.work();
  await queue.runNextFor('root-chat');

  const prompt = JSON.stringify(promptAfterInterrupt);
  assert.match(prompt, /"previous_status":"pending_init"/);
  assert.match(prompt, /Message Type: FINAL_ANSWER/);
  assert.match(prompt, /Agent was interrupted\./);
  assert.equal(prompt.match(/Message Type: FINAL_ANSWER/g)?.length, 1);
  assert.match(prompt, /"agent_status":"interrupted"/);
  assert.equal(await streamStore.getStreamStatus(child.id), 'cancelled');
  assert.equal(
    queue.turns.some((turn) => turn.streamId === child.id),
    false,
  );
  await queue.runNextFor('root-chat');
  assert.equal(rootCalls, 3, 'the serialized terminal-mail fallback is empty');

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'reuse-root-turn', input: 'assign fresh work' },
  );
  await queue.runNextFor('root-chat');
  assert.equal(queue.turns.length, 1);
  assert.equal(queue.turns[0]?.kind, 'mailbox');
  assert.equal(queue.turns[0]?.chatId, 'researcher-chat');
  await queue.runNextFor('researcher-chat');
  assert.equal(
    researcherCalls.length,
    1,
    'the interrupted agent remains reusable',
  );
});

test('interrupt_agent can retry terminal projection before deleting a queued child turn', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new FailFirstMailboxEnqueueStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let rootCalls = 0;
  let promptAfterRetry: unknown;
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      rootCalls++;
      if (rootCalls <= 2) {
        return toolCallResponse(
          'interrupt_agent',
          `interrupt-retry-${rootCalls}`,
          { target: '/root/researcher' },
        );
      }
      promptAfterRetry = prompt;
      return textResponse('child interrupted after retry');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('must not run', []),
    sandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: rootModel,
      sandbox,
      instructions: [],
      subagents: [researcher],
    }),
    { store, streamStore, mailboxStore, queue, approvalMutex },
  );
  await createAgentChats(store, [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'researcher-chat',
      path: '/root/researcher',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]);

  const child = await runtime.enqueue(
    { chatId: 'researcher-chat', userId: 'user-1' },
    { id: 'retryable-interrupt-child', input: 'research this' },
  );
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'retryable-interrupt-root', input: 'stop the child' },
  );
  await using _worker = await runtime.work();
  await queue.runNextFor('root-chat');

  const prompt = JSON.stringify(promptAfterRetry);
  assert.equal(rootCalls, 3);
  assert.match(prompt, /"previous_status":"interrupted"/);
  assert.match(prompt, /Message Type: FINAL_ANSWER/);
  assert.match(prompt, /Agent was interrupted\./);
  assert.equal(prompt.match(/Message Type: FINAL_ANSWER/g)?.length, 1);
  assert.equal(await streamStore.getStreamStatus(child.id), 'cancelled');
  assert.equal(
    queue.turns.some((turn) => turn.streamId === child.id),
    false,
  );
});

test('interrupt_agent aborts a running child across runtime instances without queue-local access', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queueState = new SharedTurnQueueState();
  const rootQueue = new SharedControlledTurnQueue(queueState);
  const childQueue = new SharedControlledTurnQueue(queueState);
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const childStarted = Promise.withResolvers<void>();
  let childCalls = 0;
  const childModel = new MockLanguageModelV4({
    doStream: async () => {
      childCalls++;
      childStarted.resolve();
      return {
        stream: simulateReadableStream({
          initialDelayInMs: 5_000,
          chunks: [
            { type: 'text-start', id: 'child-text' },
            {
              type: 'text-delta',
              id: 'child-text',
              delta: 'must not complete',
            },
            { type: 'text-end', id: 'child-text' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: '' },
              usage,
            },
          ],
        }),
      };
    },
  });

  let rootCalls = 0;
  let promptAfterInterrupt: unknown;
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      rootCalls++;
      if (rootCalls === 1) {
        return toolCallResponse('interrupt_agent', 'interrupt-active-child', {
          target: '/root/researcher',
        });
      }
      promptAfterInterrupt = prompt;
      return textResponse('active child interrupted');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: childModel,
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  await createAgentChats(store, [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'researcher-chat',
      path: '/root/researcher',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]);
  const rootRuntime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue: rootQueue,
  });
  const childRuntime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue: childQueue,
  });
  await using _rootWorker = await rootRuntime.work();
  await using _childWorker = await childRuntime.work();

  const child = await childRuntime.enqueue(
    { chatId: 'researcher-chat', userId: 'user-1' },
    { id: 'active-child-turn', input: 'start long research' },
  );
  const activeChild = childQueue.runNextFor('researcher-chat');
  await settleWithin(childStarted.promise, 'running child starts');
  await rootRuntime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'interrupting-root-turn', input: 'interrupt the child' },
  );
  await rootQueue.runNextFor('root-chat');
  await settleWithin(activeChild, 'running child stops after interruption');

  const prompt = JSON.stringify(promptAfterInterrupt);
  assert.match(prompt, /"previous_status":"running"/);
  assert.match(prompt, /Message Type: FINAL_ANSWER/);
  assert.match(prompt, /Agent was interrupted\./);
  assert.equal(childCalls, 1);
  assert.equal(await streamStore.getStreamStatus(child.id), 'cancelled');
  assert.equal(
    await mailboxStore.hasPending({ chatId: 'root-chat', userId: 'user-1' }),
    false,
    'terminal projection is delivered exactly once into the next root step',
  );
});

test('interrupt_agent rejects root and self targets', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let calls = 0;
  let finalPrompt: unknown;
  const caller = defineAgent({
    name: 'caller',
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        calls++;
        if (calls === 1) {
          return toolCallResponse('interrupt_agent', 'interrupt-root', {
            target: '/root',
          });
        }
        if (calls === 2) {
          return toolCallResponse('interrupt_agent', 'interrupt-self', {
            target: '/root/caller',
          });
        }
        finalPrompt = prompt;
        return textResponse('invalid targets rejected');
      },
    }),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: textModel('root', []),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      subagents: [caller],
    }),
    { store, streamStore, mailboxStore, queue, approvalMutex },
  );
  await createAgentChats(store, [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'caller-chat',
      path: '/root/caller',
      parentChatId: 'root-chat',
      declarationName: 'caller',
    },
  ]);

  await runtime.enqueue(
    { chatId: 'caller-chat', userId: 'user-1' },
    { id: 'invalid-interrupts', input: 'try invalid targets' },
  );
  await using _worker = await runtime.work();
  await queue.runNextFor('caller-chat');

  const prompt = JSON.stringify(finalPrompt);
  assert.match(prompt, /root agent cannot be interrupted/);
  assert.match(prompt, /agent cannot interrupt itself/);
});

test('interrupt_agent leaves terminal and approval-paused children unchanged', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const sandbox = async () => ({}) as AgentSandbox;
  const completed = defineAgent({
    name: 'completed',
    model: textModel('completed child', []),
    sandbox,
    instructions: [],
  });
  const paused = defineAgent({
    name: 'paused',
    model: new MockLanguageModelV4({
      doStream: async () =>
        toolCallResponse('publish', 'publish-paused-result', {
          report: 'ready',
        }),
    }),
    sandbox,
    instructions: [],
    tools: {
      publish: defineTool({
        description: 'Publish a report',
        inputSchema: z.object({ report: z.string() }),
        needsApproval: true,
        execute: async ({ report }) => report,
      }),
    },
  });
  let rootCalls = 0;
  let finalPrompt: unknown;
  const root = defineAgent({
    name: 'root',
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        rootCalls++;
        if (rootCalls === 1) {
          return toolCallResponse('interrupt_agent', 'interrupt-completed', {
            target: '/root/completed',
          });
        }
        if (rootCalls === 2) {
          return toolCallResponse('interrupt_agent', 'interrupt-paused', {
            target: '/root/paused',
          });
        }
        finalPrompt = prompt;
        return textResponse('terminal children unchanged');
      },
    }),
    sandbox,
    instructions: [],
    subagents: [completed, paused],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    queue,
    approvalMutex,
  });
  await createAgentChats(store, [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'completed-chat',
      path: '/root/completed',
      parentChatId: 'root-chat',
      declarationName: 'completed',
    },
    {
      id: 'paused-chat',
      path: '/root/paused',
      parentChatId: 'root-chat',
      declarationName: 'paused',
    },
  ]);

  const completedTurn = await runtime.enqueue(
    { chatId: 'completed-chat', userId: 'user-1' },
    { id: 'completed-turn', input: 'finish' },
  );
  const pausedTurn = await runtime.enqueue(
    { chatId: 'paused-chat', userId: 'user-1' },
    { id: 'paused-turn', input: 'prepare publication' },
  );
  await using _worker = await runtime.work();
  await queue.runNextFor('completed-chat');
  await queue.runNextFor('paused-chat');
  await mailboxStore.drain({ chatId: 'root-chat', userId: 'user-1' });

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'inspect-terminal-interrupts', input: 'interrupt terminal children' },
  );
  await queue.runNextFor('root-chat');

  const prompt = JSON.stringify(finalPrompt);
  assert.match(prompt, /"previous_status":\{"completed":"completed child"\}/);
  assert.match(prompt, /"previous_status":"running"/);
  assert.equal(
    await streamStore.getStreamStatus(completedTurn.id),
    'completed',
  );
  assert.equal(await streamStore.getStreamStatus(pausedTurn.id), 'completed');
  assert.equal(
    await mailboxStore.hasPending({ chatId: 'root-chat', userId: 'user-1' }),
    false,
    'no new terminal projection is emitted for no-op interruptions',
  );
});

test('wait_agent returns for pending caller mail without consuming it', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const conversation = { chatId: 'root-chat', userId: 'user-1' };
  const prompts: unknown[] = [];
  let runtime!: AgentRuntime;
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      calls++;
      if (calls === 1) {
        await runtime.deliver(
          createInterAgentCommunication({
            author: { chatId: 'child-chat', userId: 'user-1' },
            recipient: conversation,
            content: 'mail delivered before the wait tool executes',
          }),
          MessageDeliveryMode.QueueOnly,
        );
        return toolCallResponse('wait_agent', 'wait-for-caller-mail', {
          timeout_ms: 10_000,
        });
      }
      return textResponse('caller observed its pending mail');
    },
  });
  const root = defineAgent({
    name: 'root',
    model,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  await runtime.enqueue(conversation, {
    id: 'wait-for-pending-mail',
    input: 'Wait for an agent response',
  });
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(calls, 2);
  const secondPrompt = JSON.stringify(prompts[1]);
  assert.match(secondPrompt, /"timed_out":false/);
  assert.match(secondPrompt, /mail delivered before the wait tool executes/);
  assert.equal(
    await mailboxStore.hasPending(conversation),
    false,
    'the next model step consumes mail that wait_agent left pending',
  );
});

test('wait_agent is released by cross-runtime mail that reaches the next model step', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queueState = new SharedTurnQueueState();
  const callerQueue = new SharedControlledTurnQueue(queueState);
  const deliveryQueue = new SharedControlledTurnQueue(queueState);
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const conversation = { chatId: 'root-chat', userId: 'user-1' };
  const waitRequested = Promise.withResolvers<void>();
  const prompts: unknown[] = [];
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      calls++;
      if (calls === 1) {
        waitRequested.resolve();
        return toolCallResponse('wait_agent', 'wait-for-cross-runtime-mail', {
          timeout_ms: 10_000,
        });
      }
      return textResponse('cross-runtime mail observed');
    },
  });
  const root = defineAgent({
    name: 'root',
    model,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const callerRuntime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue: callerQueue,
  });
  const deliveryRuntime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue: deliveryQueue,
  });
  await using _callerWorker = await callerRuntime.work();
  await using _deliveryWorker = await deliveryRuntime.work();

  await callerRuntime.enqueue(conversation, {
    id: 'cross-runtime-wait',
    input: 'Wait for the remote result',
  });
  const running = callerQueue.runNextFor(conversation.chatId);
  await settleWithin(waitRequested.promise, 'wait_agent tool is requested');
  await deliveryRuntime.deliver(
    createInterAgentCommunication({
      author: { chatId: 'remote-child', userId: 'user-1' },
      recipient: conversation,
      content: 'mail from another runtime instance',
    }),
    MessageDeliveryMode.QueueOnly,
  );
  await settleWithin(running, 'cross-runtime wait_agent turn completes');

  assert.equal(calls, 2);
  const secondPrompt = JSON.stringify(prompts[1]);
  assert.match(secondPrompt, /"timed_out":false/);
  assert.match(secondPrompt, /mail from another runtime instance/);
  assert.equal(await mailboxStore.hasPending(conversation), false);

  await callerQueue.runNextFor(conversation.chatId);
  assert.equal(
    calls,
    2,
    'the serialized fallback is empty after safe-step delivery',
  );
});

test('wait_agent reports a bounded timeout when no mail arrives', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const realNow = Date.now.bind(Date);
  let advanceWaitClock = false;
  let clock = realNow();
  t.mock.method(Date, 'now', () => {
    if (!advanceWaitClock) return realNow();
    clock += 10_000;
    return clock;
  });

  const prompts: unknown[] = [];
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      calls++;
      if (calls === 1) {
        advanceWaitClock = true;
        return toolCallResponse('wait_agent', 'wait-until-timeout', {
          timeout_ms: 10_000,
        });
      }
      advanceWaitClock = false;
      return textResponse('continued after timeout');
    },
  });
  const root = defineAgent({
    name: 'root',
    model,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'bounded-wait', input: 'Wait briefly' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(calls, 2);
  assert.match(JSON.stringify(prompts[1]), /"timed_out":true/);
});

test('cancelling the caller aborts an active wait_agent call', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new WaitObservedMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      return toolCallResponse('wait_agent', 'cancel-active-wait', {
        timeout_ms: 10_000,
      });
    },
  });
  const root = defineAgent({
    name: 'root',
    model,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });
  const conversation = { chatId: 'root-chat', userId: 'user-1' };
  const enqueued = await runtime.enqueue(conversation, {
    id: 'cancel-wait',
    input: 'Wait until cancelled',
  });
  await using _worker = await runtime.work();
  const running = queue.runNext();
  await settleWithin(
    mailboxStore.pendingChecked.promise,
    'wait_agent reaches the pending-mail check',
  );

  await runtime.observe(conversation).cancel(enqueued.id);
  await settleWithin(running, 'cancelled wait_agent turn completes');

  assert.equal(calls, 1);
  assert.equal(await streamStore.getStreamStatus(enqueued.id), 'cancelled');
});

test('send_message crosses runtime instances and reaches an active recipient at its next model step', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queueState = new SharedTurnQueueState();
  const senderQueue = new SharedControlledTurnQueue(queueState);
  const recipientQueue = new SharedControlledTurnQueue(queueState);
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  const recipientStarted = Promise.withResolvers<void>();
  const releaseRecipient = Promise.withResolvers<void>();
  const recipientPrompts: unknown[] = [];
  let recipientCalls = 0;
  const recipientModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      recipientPrompts.push(prompt);
      recipientCalls++;
      if (recipientCalls === 1) {
        recipientStarted.resolve();
        await releaseRecipient.promise;
        return toolCallResponse('list_agents', 'recipient-safe-boundary', {});
      }
      return textResponse('recipient incorporated the update');
    },
  });

  let senderCalls = 0;
  const senderModel = new MockLanguageModelV4({
    doStream: async () => {
      senderCalls++;
      if (senderCalls === 1) {
        return toolCallResponse('send_message', 'cross-runtime-message', {
          target: '/root/recipient',
          message: 'Evidence from the sender runtime',
        });
      }
      return textResponse('message sent');
    },
  });

  const sandbox = async () => ({}) as AgentSandbox;
  const sender = defineAgent({
    name: 'sender',
    model: senderModel,
    sandbox,
    instructions: [],
  });
  const recipient = defineAgent({
    name: 'recipient',
    model: recipientModel,
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: textModel('root reply', []),
    sandbox,
    instructions: [],
    subagents: [sender, recipient],
  });

  await createAgentChats(store, [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'sender-chat',
      path: '/root/sender',
      parentChatId: 'root-chat',
      declarationName: 'sender',
    },
    {
      id: 'recipient-chat',
      path: '/root/recipient',
      parentChatId: 'root-chat',
      declarationName: 'recipient',
    },
  ]);

  const senderRuntime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue: senderQueue,
  });
  const recipientRuntime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue: recipientQueue,
  });
  await using _senderWorker = await senderRuntime.work();
  await using _recipientWorker = await recipientRuntime.work();

  await recipientRuntime.enqueue(
    { chatId: 'recipient-chat', userId: 'user-1' },
    { id: 'recipient-active-turn', input: 'Start reviewing' },
  );
  const activeRecipient = recipientQueue.runNextFor('recipient-chat');
  await recipientStarted.promise;

  await senderRuntime.enqueue(
    { chatId: 'sender-chat', userId: 'user-1' },
    { id: 'sender-message-turn', input: 'Send the new evidence' },
  );
  await senderQueue.runNextFor('sender-chat');

  assert.equal(senderCalls, 2);
  assert.equal(recipientCalls, 1, 'the recipient never runs concurrently');
  assert.equal(queueState.turns.length, 1);
  assert.equal(queueState.turns[0]?.kind, 'mailbox');
  assert.equal(queueState.turns[0]?.chatId, 'recipient-chat');

  releaseRecipient.resolve();
  await activeRecipient;

  assert.equal(recipientCalls, 2);
  const secondPrompt = JSON.stringify(recipientPrompts[1]);
  assert.match(secondPrompt, /Message Type: MESSAGE/);
  assert.match(secondPrompt, /Sender: \/root\/sender/);
  assert.match(secondPrompt, /Evidence from the sender runtime/);

  await recipientQueue.runNextFor('recipient-chat');
  assert.equal(
    recipientCalls,
    2,
    'the serialized fallback is a no-op after safe-step delivery',
  );
  assert.equal(queueState.turns.length, 0);
});

test('followup_task crosses runtime instances and wakes an idle recipient', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queueState = new SharedTurnQueueState();
  const senderQueue = new SharedControlledTurnQueue(queueState);
  const recipientQueue = new SharedControlledTurnQueue(queueState);
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let senderCalls = 0;
  const senderModel = new MockLanguageModelV4({
    doStream: async () => {
      senderCalls++;
      if (senderCalls === 1) {
        return toolCallResponse('followup_task', 'cross-runtime-followup', {
          target: '/root/recipient',
          message: 'Investigate this from the sender runtime',
        });
      }
      return textResponse('follow-up sent');
    },
  });
  const recipientPrompts: unknown[] = [];
  const sandbox = async () => ({}) as AgentSandbox;
  const sender = defineAgent({
    name: 'sender',
    model: senderModel,
    sandbox,
    instructions: [],
  });
  const recipient = defineAgent({
    name: 'recipient',
    model: textModel('follow-up complete', recipientPrompts),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: textModel('root reply', []),
    sandbox,
    instructions: [],
    subagents: [sender, recipient],
  });

  await createAgentChats(store, [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'sender-chat',
      path: '/root/sender',
      parentChatId: 'root-chat',
      declarationName: 'sender',
    },
    {
      id: 'recipient-chat',
      path: '/root/recipient',
      parentChatId: 'root-chat',
      declarationName: 'recipient',
    },
  ]);

  const senderRuntime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue: senderQueue,
  });
  const recipientRuntime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue: recipientQueue,
  });
  await using _senderWorker = await senderRuntime.work();
  await using _recipientWorker = await recipientRuntime.work();

  await senderRuntime.enqueue(
    { chatId: 'sender-chat', userId: 'user-1' },
    { id: 'sender-followup-turn', input: 'Assign the follow-up' },
  );
  await senderQueue.runNextFor('sender-chat');

  assert.equal(senderCalls, 2);
  assert.equal(recipientPrompts.length, 0);
  assert.equal(queueState.turns.length, 1);
  assert.equal(queueState.turns[0]?.kind, 'mailbox');
  assert.equal(queueState.turns[0]?.chatId, 'recipient-chat');

  await recipientQueue.runNextFor('recipient-chat');

  assert.equal(recipientPrompts.length, 1);
  const prompt = JSON.stringify(recipientPrompts[0]);
  assert.match(prompt, /Message Type: NEW_TASK/);
  assert.match(prompt, /Sender: \/root\/sender/);
  assert.match(prompt, /Investigate this from the sender runtime/);
  assert.equal(queueState.turns.length, 0);
});

test('followup_task stays behind an unstarted initial ask as a distinct later turn', async (t) => {
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
                toolCallId: 'queued-followup',
                toolName: 'followup_task',
                input: JSON.stringify({
                  target: '/root/researcher',
                  message: 'Verify this after the initial task',
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
      return textResponse('follow-up assigned');
    },
  });
  const researcherPrompts: unknown[] = [];
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('research complete', researcherPrompts),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  for (const chat of [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'researcher-chat',
      path: '/root/researcher',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }

  await runtime.enqueue(
    { chatId: 'researcher-chat', userId: 'user-1' },
    { id: 'researcher-initial', input: 'Do the initial research' },
  );
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-followup', input: 'Assign follow-up work' },
  );
  await using _worker = await runtime.work();
  await queue.runNextFor('root-chat');

  assert.equal(
    queue.turns.filter((turn) => turn.chatId === 'researcher-chat').length,
    2,
  );
  await queue.runNextFor('researcher-chat');
  assert.equal(researcherPrompts.length, 1);
  assert.match(JSON.stringify(researcherPrompts[0]), /Do the initial research/);
  assert.doesNotMatch(
    JSON.stringify(researcherPrompts[0]),
    /Verify this after the initial task/,
  );

  await queue.runNextFor('researcher-chat');
  assert.equal(researcherPrompts.length, 2);
  assert.match(
    JSON.stringify(researcherPrompts[1]),
    /Verify this after the initial task/,
  );
});

test('followup_task rejects the root agent without storing mail or scheduling a turn', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let calls = 0;
  let promptAfterTool: unknown;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      calls++;
      if (calls === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'followup-root',
                toolName: 'followup_task',
                input: JSON.stringify({
                  target: '/root',
                  message: 'Do another root task',
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
      promptAfterTool = prompt;
      return textResponse('root continues');
    },
  });
  const root = defineAgent({
    name: 'root',
    model,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'Try an invalid follow-up' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(calls, 2);
  assert.match(
    JSON.stringify(promptAfterTool),
    /root agent cannot receive a follow-up/,
  );
  assert.equal(queue.turns.length, 0);
  assert.equal(
    await mailboxStore.hasPending({ chatId: 'root-chat', userId: 'user-1' }),
    false,
  );
});

test('list_agents reports the root tree with canonical paths and current statuses', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let calls = 0;
  let promptAfterList: unknown;
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      calls++;
      if (calls === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'list-1',
                toolName: 'list_agents',
                input: '{}',
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
      promptAfterList = prompt;
      return textResponse('tree listed');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('research complete', []),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
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
    id: 'researcher-chat',
    userId: 'user-1',
    metadata: {
      zukhrufTreeId: 'root-chat',
      zukhruf: {
        path: '/root/researcher',
        parentChatId: 'root-chat',
        declarationName: 'researcher',
      },
    },
  });
  await runtime.enqueue(
    { chatId: 'researcher-chat', userId: 'user-1' },
    { id: 'queued-researcher-turn', input: 'Research after the root lists' },
  );
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'Show the agent tree' },
  );
  await using _worker = await runtime.work();
  await queue.runNextFor('root-chat');

  assert.equal(calls, 2);
  const prompt = JSON.stringify(promptAfterList);
  assert.match(prompt, /"agent_name":"\/root"/);
  assert.match(prompt, /"agent_status":"running"/);
  assert.match(prompt, /"last_task_message":"Main thread"/);
  assert.match(prompt, /"agent_name":"\/root\/researcher"/);
  assert.match(prompt, /"agent_status":"pending_init"/);
  assert.match(prompt, /"last_task_message":null/);
});

test('list_agents resolves a relative path prefix and returns only that subtree', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let calls = 0;
  let promptAfterList: unknown;
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      calls++;
      if (calls === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'list-subtree',
                toolName: 'list_agents',
                input: JSON.stringify({ path_prefix: 'planner' }),
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
      promptAfterList = prompt;
      return textResponse('subtree listed');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('research complete', []),
    sandbox,
    instructions: [],
  });
  const planner = defineAgent({
    name: 'planner',
    model: textModel('planning complete', []),
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const reviewer = defineAgent({
    name: 'reviewer',
    model: textModel('review complete', []),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [planner, reviewer],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  for (const chat of [
    {
      id: 'planner-chat',
      path: '/root/planner',
      parentChatId: 'root-chat',
      declarationName: 'planner',
    },
    {
      id: 'researcher-chat',
      path: '/root/planner/researcher',
      parentChatId: 'planner-chat',
      declarationName: 'researcher',
    },
    {
      id: 'reviewer-chat',
      path: '/root/reviewer',
      parentChatId: 'root-chat',
      declarationName: 'reviewer',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'Show the planner subtree' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  const prompt = JSON.stringify(promptAfterList);
  assert.match(prompt, /"agent_name":"\/root\/planner"/);
  assert.match(prompt, /"agent_name":"\/root\/planner\/researcher"/);
  assert.doesNotMatch(prompt, /"agent_name":"\/root","/);
  assert.doesNotMatch(prompt, /\/root\/reviewer/);
});

test('list_agents reports a completed child with its result and last task', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let rootCalls = 0;
  let promptAfterList: unknown;
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      rootCalls++;
      if (rootCalls === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'list-completed',
                toolName: 'list_agents',
                input: '{}',
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
      promptAfterList = prompt;
      return textResponse('completion listed');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('verified result', []),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  for (const chat of [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'researcher-chat',
      path: '/root/researcher',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }
  await runtime.enqueue(
    { chatId: 'researcher-chat', userId: 'user-1' },
    { id: 'researcher-turn', input: 'Verify the storage claim' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'Show completed work' },
  );
  await queue.runNext();

  const prompt = JSON.stringify(promptAfterList);
  assert.match(prompt, /"agent_name":"\/root\/researcher"/);
  assert.match(prompt, /"agent_status":\{"completed":"verified result"\}/);
  assert.match(prompt, /"last_task_message":"Verify the storage claim"/);
});

test('list_agents reports a completed child with a queued follow-up as running', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let rootCalls = 0;
  let promptAfterList: unknown;
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      rootCalls++;
      if (rootCalls === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'list-scheduled-followup',
                toolName: 'list_agents',
                input: '{}',
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
      promptAfterList = prompt;
      return textResponse('scheduled work listed');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('initial result', []),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  for (const chat of [
    {
      id: 'root-chat',
      path: '/root',
      parentChatId: null,
      declarationName: 'root',
    },
    {
      id: 'researcher-chat',
      path: '/root/researcher',
      parentChatId: 'root-chat',
      declarationName: 'researcher',
    },
  ]) {
    await store.createChat({
      id: chat.id,
      userId: 'user-1',
      metadata: {
        zukhrufTreeId: 'root-chat',
        zukhruf: {
          path: chat.path,
          parentChatId: chat.parentChatId,
          declarationName: chat.declarationName,
        },
      },
    });
  }

  await runtime.enqueue(
    { chatId: 'researcher-chat', userId: 'user-1' },
    { id: 'researcher-initial', input: 'Do the initial research' },
  );
  await using _worker = await runtime.work();
  await queue.runNextFor('researcher-chat');
  await runtime.deliver(
    createInterAgentCommunication({
      author: { chatId: 'root-chat', userId: 'user-1' },
      recipient: { chatId: 'researcher-chat', userId: 'user-1' },
      content: 'Check the new edge case',
    }),
    MessageDeliveryMode.TriggerTurn,
  );
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-list-scheduled', input: 'Show current work' },
  );
  await queue.runNextFor('root-chat');

  const prompt = JSON.stringify(promptAfterList);
  assert.match(prompt, /"agent_name":"\/root\/researcher"/);
  assert.match(prompt, /"agent_status":"running"/);
  assert.doesNotMatch(prompt, /"completed":"initial result"/);
});

test('nested agents run independently, consume sibling mail, and remain visible from the root', async (t) => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let rootCalls = 0;
  let rootPromptAfterList: unknown;
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      rootCalls++;
      switch (rootCalls) {
        case 1:
          return toolCallResponse('spawn_agent', 'spawn-planner', {
            agent_type: 'planner',
            task_name: 'planner',
            message: 'Plan the investigation',
          });
        case 2:
          return toolCallResponse('spawn_agent', 'spawn-reviewer', {
            agent_type: 'reviewer',
            task_name: 'reviewer',
            message: 'Review the evidence',
          });
        case 3:
          return textResponse('root delegated');
        case 4:
          return toolCallResponse('list_agents', 'list-nested-tree', {});
        default:
          rootPromptAfterList = prompt;
          return textResponse('root inspected the tree');
      }
    },
  });

  let plannerCalls = 0;
  const plannerModel = new MockLanguageModelV4({
    doStream: async () => {
      plannerCalls++;
      switch (plannerCalls) {
        case 1:
          return toolCallResponse('spawn_agent', 'spawn-researcher', {
            agent_type: 'researcher',
            task_name: 'researcher',
            message: 'Research the edge case',
          });
        case 2:
          return toolCallResponse('send_message', 'message-reviewer', {
            target: '/root/reviewer',
            message: 'Planner evidence for sibling review',
          });
        default:
          return textResponse('planner complete');
      }
    },
  });
  const reviewerPrompts: unknown[] = [];
  const researcherPrompts: unknown[] = [];
  const sandbox = async () => ({}) as AgentSandbox;
  const researcher = defineAgent({
    name: 'researcher',
    model: textModel('researcher complete', researcherPrompts),
    sandbox,
    instructions: [],
  });
  const planner = defineAgent({
    name: 'planner',
    model: plannerModel,
    sandbox,
    instructions: [],
    subagents: [researcher],
  });
  const reviewer = defineAgent({
    name: 'reviewer',
    model: textModel('reviewer complete', reviewerPrompts),
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model: rootModel,
    sandbox,
    instructions: [],
    subagents: [planner, reviewer],
  });
  const runtime = new AgentRuntime(root, {
    store,
    streamStore,
    mailboxStore,
    approvalMutex,
    queue,
  });

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-delegate', input: 'Delegate the investigation' },
  );
  await using _worker = await runtime.work();
  await queue.runNext();

  assert.equal(rootCalls, 3);
  assert.equal(queue.turns.length, 2);
  assert.deepEqual(
    queue.turns.map((turn) => (turn.kind === 'ask' ? turn.input : turn.kind)),
    ['Plan the investigation', 'Review the evidence'],
  );

  await queue.runNext();
  assert.equal(plannerCalls, 3);
  assert.equal(queue.turns.length, 2);

  await queue.runNext();
  assert.equal(reviewerPrompts.length, 1);
  const reviewerPrompt = JSON.stringify(reviewerPrompts[0]);
  assert.match(reviewerPrompt, /Review the evidence/);
  assert.match(reviewerPrompt, /Message Type: MESSAGE/);
  assert.match(reviewerPrompt, /Planner evidence for sibling review/);

  await queue.runNext();
  assert.equal(researcherPrompts.length, 1);
  assert.match(JSON.stringify(researcherPrompts[0]), /Research the edge case/);
  assert.equal(queue.turns.length, 0);

  const chats = await store.listChats({ userId: 'user-1' });
  const chatAtPath = (path: string) =>
    chats.find(
      (chat) =>
        (chat.metadata?.zukhruf as { path?: string } | undefined)?.path ===
        path,
    );
  const reviewerChat = chatAtPath('/root/reviewer');
  assert.ok(reviewerChat);
  const reviewerHistory = await runtime
    .observe({ chatId: reviewerChat.id, userId: reviewerChat.userId })
    .engine.getMessages();
  assert.deepEqual(
    reviewerHistory.flatMap((message) => {
      const communication = (
        message.metadata as
          | { interAgentCommunication?: { content?: string } }
          | undefined
      )?.interAgentCommunication;
      return communication?.content ? [communication.content] : [];
    }),
    ['Planner evidence for sibling review'],
  );

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-inspect-tree', input: 'Inspect all completed agents' },
  );
  await queue.runNext();

  const listed = JSON.stringify(rootPromptAfterList);
  for (const path of [
    '/root/planner',
    '/root/planner/researcher',
    '/root/reviewer',
  ]) {
    assert.match(listed, new RegExp(`"agent_name":"${path}"`));
  }
  assert.match(listed, /"completed":"planner complete"/);
  assert.match(listed, /"completed":"researcher complete"/);
  assert.match(listed, /"completed":"reviewer complete"/);
});
