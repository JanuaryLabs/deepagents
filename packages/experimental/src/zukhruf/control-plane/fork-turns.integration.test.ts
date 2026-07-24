import { type ToolSet, type UIMessage, simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
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
  SqliteMailboxStore,
  TurnQueue,
  type TurnRef,
  defineAgent,
} from '@deepagents/experimental/zukhruf';

class ControlledTurnQueue extends TurnQueue {
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
    void _options;
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

function spawnResponse(forkTurns?: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'spawn-worker',
          toolName: 'spawn_agent',
          input: JSON.stringify({
            agent_type: 'worker',
            task_name: 'delegated',
            message: 'child task',
            ...(forkTurns === undefined ? {} : { fork_turns: forkTurns }),
          }),
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

function toolCallResponse(toolName: string, input: unknown = {}) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: `call-${toolName}`,
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

function textOf(messages: UIMessage[]): string {
  return messages
    .flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === 'text' ? [part.text] : [],
      ),
    )
    .join('\n');
}

async function spawnAfter(
  t: TestContext,
  options: {
    history: Array<{ input: string; answer: string }>;
    forkTurns?: string;
    rootResponses?: Array<
      | ReturnType<typeof textResponse>
      | ReturnType<typeof spawnResponse>
      | ReturnType<typeof toolCallResponse>
    >;
    tools?: ToolSet;
    expectSpawn?: boolean;
  },
) {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });

  let rootCall = 0;
  const rootModel = new MockLanguageModelV4({
    doStream: async () => {
      const call = rootCall++;
      const scripted = options.rootResponses?.[call];
      if (options.rootResponses) {
        assert.ok(scripted, `missing scripted root response ${call}`);
        return scripted;
      }
      if (call < options.history.length) {
        return textResponse(options.history[call].answer);
      }
      if (call === options.history.length) {
        return spawnResponse(options.forkTurns);
      }
      return textResponse('spawn submitted');
    },
  });
  const childPrompts: unknown[] = [];
  const childModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      childPrompts.push(prompt);
      return textResponse('child complete');
    },
  });
  const sandbox = async () => ({}) as AgentSandbox;
  const worker = defineAgent({
    name: 'worker',
    model: childModel,
    sandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: rootModel,
      sandbox,
      instructions: [],
      tools: options.tools,
      subagents: [worker],
    }),
    { store, streamStore, mailboxStore, queue },
  );
  await using workerHandle = await runtime.work();
  void workerHandle;

  for (const [index, turn] of options.history.entries()) {
    await runtime.enqueue(
      { chatId: 'root-chat', userId: 'user-1' },
      { id: `history-${index}`, input: turn.input },
    );
    await queue.runNext();
  }
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'spawn-turn', input: 'delegate current request' },
  );
  await queue.runNext();

  const parentHistory = await runtime
    .observe({ chatId: 'root-chat', userId: 'user-1' })
    .engine.getMessages();
  const childTurn = queue.turns[0];
  if (!childTurn) {
    assert.equal(options.expectSpawn, false, JSON.stringify(parentHistory));
    return {
      childPrompts,
      childChat: undefined,
      forkedHistory: [],
      parentHistory,
      tree: await store.listChats({ userId: 'user-1' }),
    };
  }
  assert.notEqual(options.expectSpawn, false);
  assert.ok(childTurn.kind === 'ask', JSON.stringify(parentHistory));
  const conversation = { chatId: childTurn.chatId, userId: childTurn.userId };
  const childChat = await store.getChat(childTurn.chatId);
  const forkedHistory = await runtime
    .observe(conversation)
    .engine.getMessages();
  await queue.runNext();

  return {
    childPrompts,
    childChat,
    forkedHistory,
    parentHistory,
    tree: await store.listChats({ userId: 'user-1' }),
  };
}

test('spawn_agent defaults fork_turns to all parent turns', async (t) => {
  const result = await spawnAfter(t, {
    history: [{ input: 'first question', answer: 'first answer' }],
  });

  assert.deepEqual(
    result.forkedHistory.map((message) => message.role),
    ['user', 'assistant', 'user'],
    JSON.stringify({
      child: result.childChat?.metadata,
      parent: textOf(result.parentHistory),
    }),
  );
  assert.equal(
    textOf(result.forkedHistory),
    'first question\nfirst answer\ndelegate current request',
  );

  const prompt = JSON.stringify(result.childPrompts[0]);
  assert.match(prompt, /first question/);
  assert.match(prompt, /first answer/);
  assert.match(prompt, /delegate current request/);
  assert.match(prompt, /child task/);
});

test('spawn_agent fork_turns none starts the child with no parent history', async (t) => {
  const result = await spawnAfter(t, {
    history: [{ input: 'private parent question', answer: 'private answer' }],
    forkTurns: 'none',
  });

  assert.deepEqual(result.forkedHistory, []);
  const prompt = JSON.stringify(result.childPrompts[0]);
  assert.doesNotMatch(prompt, /private parent question/);
  assert.doesNotMatch(prompt, /private answer/);
  assert.match(prompt, /child task/);
});

test('spawn_agent fork_turns N keeps the latest N user turns', async (t) => {
  const result = await spawnAfter(t, {
    history: [
      { input: 'old question', answer: 'old answer' },
      { input: 'recent question', answer: 'recent answer' },
    ],
    forkTurns: '2',
  });

  const history = textOf(result.forkedHistory);
  assert.doesNotMatch(history, /old question/);
  assert.doesNotMatch(history, /old answer/);
  assert.match(history, /recent question/);
  assert.match(history, /recent answer/);
  assert.match(history, /delegate current request/);
});

test('forked history keeps final assistant content without tool traffic', async (t) => {
  const result = await spawnAfter(t, {
    history: [{ input: 'look up the private record', answer: '' }],
    rootResponses: [
      toolCallResponse('private_lookup'),
      textResponse('public conclusion'),
      spawnResponse(),
      textResponse('spawn submitted'),
    ],
    tools: {
      private_lookup: tool({
        inputSchema: z.object({}),
        execute: async () => 'private tool result',
      }),
    },
  });

  const history = JSON.stringify(result.forkedHistory);
  assert.match(history, /public conclusion/);
  assert.doesNotMatch(history, /private_lookup/);
  assert.doesNotMatch(history, /private tool result/);
});

test('spawn_agent rejects invalid fork_turns before creating a child', async (t) => {
  const result = await spawnAfter(t, {
    history: [],
    forkTurns: '0',
    expectSpawn: false,
  });

  assert.equal(result.tree.length, 1);
  assert.match(
    JSON.stringify(result.parentHistory),
    /"fork_turns":"0".*"state":"output-error"|"state":"output-error".*"fork_turns":"0"/,
  );
});
