import type { LanguageModelV4FunctionTool } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

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
    options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    void options;
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

function toolCallResponse(toolName: string, input: unknown) {
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

function systemText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .filter(
      (message): message is { role: 'system'; content: string } =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        message.role === 'system' &&
        'content' in message &&
        typeof message.content === 'string',
    )
    .map((message) => message.content)
    .join('\n');
}

function functionTools(tools: unknown): LanguageModelV4FunctionTool[] {
  return Array.isArray(tools)
    ? tools.filter(
        (candidate): candidate is LanguageModelV4FunctionTool =>
          typeof candidate === 'object' &&
          candidate !== null &&
          'type' in candidate &&
          candidate.type === 'function',
      )
    : [];
}

function harness(t: TestContext) {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });
  return { store, streamStore, mailboxStore, queue };
}

test('host config injects root guidance, spawn guidance, namespace, and wait bounds', async (t) => {
  const h = harness(t);
  let request: { prompt: unknown; tools: unknown } | undefined;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt, tools }) => {
      request = { prompt, tools };
      return textResponse('done');
    },
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      multiAgentV2: {
        rootAgentUsageHintText: 'ROOT COLLABORATION GUIDANCE',
        subagentUsageHintText: 'CHILD COLLABORATION GUIDANCE',
        usageHintText: 'Prefer delegation for independent work.',
        toolNamespace: 'agents',
        minWaitTimeoutMs: 111,
        defaultWaitTimeoutMs: 222,
        maxWaitTimeoutMs: 333,
        nonCodeModeOnly: true,
      },
    },
  );
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'work' },
  );
  await using worker = await runtime.work();
  void worker;
  await h.queue.runNext();

  assert.ok(request);
  assert.match(systemText(request.prompt), /ROOT COLLABORATION GUIDANCE/);
  assert.doesNotMatch(
    systemText(request.prompt),
    /CHILD COLLABORATION GUIDANCE/,
  );
  const tools = functionTools(request.tools);
  assert.deepEqual(tools.map((tool) => tool.name).toSorted(), [
    'followup_task',
    'interrupt_agent',
    'list_agents',
    'send_message',
    'spawn_agent',
    'wait_agent',
  ]);
  for (const collaborationTool of tools) {
    assert.deepEqual(collaborationTool.providerOptions?.openai?.namespace, {
      name: 'agents',
      description: 'Tools for spawning and managing sub-agents.',
    });
  }
  const spawn = tools.find((tool) => tool.name === 'spawn_agent');
  assert.match(
    spawn?.description ?? '',
    /Prefer delegation for independent work\./,
  );
  const wait = tools.find((tool) => tool.name === 'wait_agent');
  const timeoutSchema = (
    wait?.inputSchema as {
      properties?: { timeout_ms?: { minimum?: number; maximum?: number } };
    }
  ).properties?.timeout_ms;
  assert.equal(timeoutSchema?.minimum, 111);
  assert.equal(timeoutSchema?.maximum, 333);
});

test('subagent guidance replaces root guidance on a child turn', async (t) => {
  const h = harness(t);
  let childPrompt: unknown;
  const child = defineAgent({
    name: 'worker',
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        childPrompt = prompt;
        return textResponse('done');
      },
    }),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: child.model,
      sandbox: child.sandbox,
      instructions: [],
      subagents: [child],
    }),
    {
      ...h,
      multiAgentV2: {
        rootAgentUsageHintText: 'ROOT COLLABORATION GUIDANCE',
        subagentUsageHintText: 'CHILD COLLABORATION GUIDANCE',
      },
    },
  );
  await h.store.createChat({
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
  await h.store.createChat({
    id: 'child-chat',
    userId: 'user-1',
    metadata: {
      zukhrufTreeId: 'root-chat',
      zukhruf: {
        path: '/root/worker',
        parentChatId: 'root-chat',
        declarationName: 'worker',
      },
    },
  });
  await runtime.enqueue(
    { chatId: 'child-chat', userId: 'user-1' },
    { id: 'child-turn', input: 'work' },
  );
  await using worker = await runtime.work();
  void worker;
  await h.queue.runNext();

  assert.match(systemText(childPrompt), /CHILD COLLABORATION GUIDANCE/);
  assert.doesNotMatch(systemText(childPrompt), /ROOT COLLABORATION GUIDANCE/);
});

test('spawn output is the canonical task name without agent_path', async (t) => {
  const h = harness(t);
  let calls = 0;
  let parentPrompt: unknown;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      calls++;
      if (calls === 1) {
        return toolCallResponse('spawn_agent', {
          agent_type: 'worker',
          task_name: 'delegated',
          message: 'child work',
          fork_turns: 'none',
        });
      }
      parentPrompt = prompt;
      return textResponse('spawned');
    },
  });
  const child = defineAgent({
    name: 'worker',
    model,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model,
      sandbox: child.sandbox,
      instructions: [],
      subagents: [child],
    }),
    h,
  );
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'delegate' },
  );
  await using worker = await runtime.work();
  void worker;
  await h.queue.runNext();

  const serialized = JSON.stringify(parentPrompt);
  assert.match(serialized, /"task_name":"\/root\/delegated"/);
  assert.doesNotMatch(serialized, /agent_path/);
});

test('interrupt_agent reports not_found for a missing target', async (t) => {
  const h = harness(t);
  let calls = 0;
  let prompt: unknown;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt: currentPrompt }) => {
      calls++;
      if (calls === 1) {
        return toolCallResponse('interrupt_agent', { target: 'missing' });
      }
      prompt = currentPrompt;
      return textResponse('done');
    },
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    h,
  );
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    { id: 'root-turn', input: 'interrupt missing' },
  );
  await using worker = await runtime.work();
  void worker;
  await h.queue.runNext();

  assert.match(JSON.stringify(prompt), /"previous_status":"not_found"/);
});

test('host config rejects invalid namespaces and wait bounds', () => {
  const sandbox = async () => ({}) as AgentSandbox;
  const declaration = defineAgent({
    name: 'root',
    model: new MockLanguageModelV4({
      doStream: async () => textResponse('done'),
    }),
    sandbox,
    instructions: [],
  });
  const h = {
    store: new InMemoryContextStore(),
    streamStore: new SqliteStreamStore(':memory:'),
    mailboxStore: new SqliteMailboxStore(':memory:'),
    queue: new ControlledTurnQueue(),
  };
  try {
    assert.throws(
      () =>
        new AgentRuntime(declaration, {
          ...h,
          multiAgentV2: { toolNamespace: 'functions' },
        }),
      /reserved tool namespace/,
    );
    assert.throws(
      () =>
        new AgentRuntime(declaration, {
          ...h,
          multiAgentV2: { toolNamespace: ' agents ' },
        }),
      /cannot be empty or padded/,
    );
    assert.throws(
      () =>
        new AgentRuntime(declaration, {
          ...h,
          multiAgentV2: { nonCodeModeOnly: false },
        }),
      /requires a nested code-mode executor/,
    );
    assert.throws(
      () =>
        new AgentRuntime(declaration, {
          ...h,
          multiAgentV2: {
            minWaitTimeoutMs: 50,
            defaultWaitTimeoutMs: 40,
            maxWaitTimeoutMs: 100,
          },
        }),
      /defaultWaitTimeoutMs.*minWaitTimeoutMs/,
    );
  } finally {
    h.streamStore.close();
    h.mailboxStore.close();
  }
});
