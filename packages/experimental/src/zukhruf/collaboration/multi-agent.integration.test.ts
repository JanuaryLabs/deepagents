import type { LanguageModelV4FunctionTool } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AgentSandbox,
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
  type StreamStore,
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

const userTurn = (id: string, text: string) => ({
  message: {
    id,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  },
  trigger: 'submit-message' as const,
});

function streamsFor(store: StreamStore): StreamManager {
  return new StreamManager({
    store,
    changeSource: new PollingChangeSource({ reads: store }),
  });
}

class ControlledTurnQueue extends TurnQueue {
  readonly turns: TurnRef[] = [];
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;

  override async push(turn: TurnRef) {
    this.turns.push(turn);
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
  const streams = streamsFor(streamStore);
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });
  return { store, streams, streamStore, mailboxStore, queue };
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
      subagents: [
        defineAgent({
          name: 'reviewer',
          description: 'Reviews the current change.',
          model,
          sandbox: async () => ({}) as AgentSandbox,
          instructions: [],
        }),
        defineAgent({
          name: 'worker',
          model,
          sandbox: async () => ({}) as AgentSandbox,
          instructions: [],
        }),
      ],
    }),
    {
      ...h,
      multiAgent: {
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
    userTurn('root-turn', 'work'),
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
  assert.match(
    spawn?.description ?? '',
    /reviewer: Reviews the current change\., worker/,
  );
  const wait = tools.find((tool) => tool.name === 'wait_agent');
  const timeoutSchema = (
    wait?.inputSchema as {
      properties?: { timeout_ms?: { minimum?: number; maximum?: number } };
    }
  ).properties?.timeout_ms;
  assert.equal(timeoutSchema?.maximum, 333);
});

test('wait_agent clamps a below-minimum timeout and reports it to the model', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const streams = streamsFor(streamStore);
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  const conversation = { chatId: 'root-chat', userId: 'user-1' };
  let runtime: AgentRuntime;
  let delivery: Promise<void> | undefined;
  let promptAfterWait: unknown;
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      calls++;
      if (calls === 1) {
        delivery = sleep(10).then(() =>
          runtime.deliver(
            createInterAgentCommunication({
              author: { chatId: 'child-chat', userId: 'user-1' },
              recipient: conversation,
              content: 'mail delivered after the requested deadline',
            }),
            MessageDeliveryMode.QueueOnly,
          ),
        );
        return toolCallResponse('wait_agent', { timeout_ms: 1 });
      }
      promptAfterWait = prompt;
      return textResponse('continued');
    },
  });

  try {
    runtime = new AgentRuntime(
      defineAgent({
        name: 'root',
        model,
        sandbox: async () => ({}) as AgentSandbox,
        instructions: [],
      }),
      {
        store,
        streams,
        mailboxStore,
        queue,
        multiAgent: {
          minWaitTimeoutMs: 50,
          defaultWaitTimeoutMs: 75,
          maxWaitTimeoutMs: 100,
        },
      },
    );
    await runtime.enqueue(conversation, userTurn('short-wait', 'Wait briefly'));
    await using worker = await runtime.work();
    void worker;
    await queue.runNext();
    await delivery;

    assert.equal(calls, 2);
    const serialized = JSON.stringify(promptAfterWait);
    assert.match(serialized, /"timed_out":false/);
    assert.match(serialized, /mail delivered after the requested deadline/);
    assert.match(
      serialized,
      /Requested timeout of 1ms was clamped to the minimum of 50ms\./,
    );
  } finally {
    try {
      await delivery;
    } finally {
      streamStore.close();
      mailboxStore.close();
    }
  }
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
      multiAgent: {
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
    userTurn('child-turn', 'work'),
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
    userTurn('root-turn', 'delegate'),
  );
  await using worker = await runtime.work();
  void worker;
  await h.queue.runNext();

  const serialized = JSON.stringify(parentPrompt);
  assert.match(serialized, /"task_name":"\/root\/delegated"/);
  assert.doesNotMatch(serialized, /agent_path/);
});

test('plugin-contributed subagent uses AI SDK code mode collaboration', async (t) => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-code-mode-'),
  );
  await writeFile(
    join(directory.path, 'reviewer.md'),
    `---\nname: reviewer\ndescription: Reviews the current change.\n---\n\nReview the implementation.\n`,
  );

  const h = harness(t);
  const requests: Array<{ prompt: unknown; tools: unknown }> = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt, tools }) => {
      requests.push({ prompt, tools });
      if (requests.length === 1) {
        return toolCallResponse('code_mode', {
          js: `return await tools.spawn_agent({ agent_type: 'engineering:reviewer', task_name: 'review', message: 'Review the implementation.', fork_turns: 'none' });`,
        });
      }
      if (requests.length === 3) {
        return toolCallResponse('code_mode', {
          js: `return await tools.list_agents({});`,
        });
      }
      return textResponse('done');
    },
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      plugins: [
        {
          name: 'engineering',
          create: () => ({ agents: [directory.path] }),
        },
      ],
    }),
    {
      ...h,
      multiAgent: { nonCodeModeOnly: false },
    },
  );

  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    userTurn('root-turn', 'Delegate the review.'),
  );
  await using worker = await runtime.work();
  void worker;
  await h.queue.runNext();
  await h.queue.runNext();

  assert.equal(requests.length, 4);
  assert.deepEqual(
    functionTools(requests[0]?.tools).map(({ name }) => name),
    ['code_mode'],
  );
  assert.deepEqual(
    functionTools(requests[2]?.tools).map(({ name }) => name),
    ['code_mode'],
  );
  assert.match(
    JSON.stringify(requests[1]?.prompt),
    /"task_name":"\/root\/review"/,
  );
  assert.match(
    JSON.stringify(requests[2]?.prompt),
    /Review the implementation\./,
  );
  assert.match(
    JSON.stringify(requests[3]?.prompt),
    /"agent_name":"\/root\/review"/,
  );
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
    userTurn('root-turn', 'interrupt missing'),
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
  const streamStore = new SqliteStreamStore(':memory:');
  const h = {
    store: new InMemoryContextStore(),
    streams: streamsFor(streamStore),
    mailboxStore: new SqliteMailboxStore(':memory:'),
    queue: new ControlledTurnQueue(),
  };
  try {
    assert.throws(
      () =>
        new AgentRuntime(declaration, {
          ...h,
          multiAgent: { toolNamespace: 'functions' },
        }),
      /reserved tool namespace/,
    );
    assert.throws(
      () =>
        new AgentRuntime(declaration, {
          ...h,
          multiAgent: { toolNamespace: ' agents ' },
        }),
      /cannot be empty or padded/,
    );
    assert.throws(
      () =>
        new AgentRuntime(declaration, {
          ...h,
          multiAgent: {
            minWaitTimeoutMs: 50,
            defaultWaitTimeoutMs: 40,
            maxWaitTimeoutMs: 100,
          },
        }),
      /defaultWaitTimeoutMs.*minWaitTimeoutMs/,
    );
    assert.throws(
      () =>
        new AgentRuntime(declaration, {
          ...h,
          multiAgent: { maxConcurrentThreadsPerSession: 0 },
        }),
      /maxConcurrentThreadsPerSession must be a positive integer/,
    );
  } finally {
    streamStore.close();
    h.mailboxStore.close();
  }
});

test('default guidance tells root and child agents the Codex concurrency slots', async (t) => {
  const h = harness(t);
  const prompts: Record<string, unknown> = {};
  const capturing = (name: string) =>
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts[name] = prompt;
        return textResponse('done');
      },
    });
  const child = defineAgent({
    name: 'worker',
    model: capturing('worker'),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: capturing('root'),
      sandbox: child.sandbox,
      instructions: [],
      subagents: [child],
    }),
    h,
  );
  await h.store.createChat({
    id: 'root-chat',
    userId: 'user-1',
    metadata: {
      zukhrufTreeId: 'root-chat',
      zukhruf: { path: '/root', parentChatId: null, declarationName: 'root' },
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
    { chatId: 'root-chat', userId: 'user-1' },
    userTurn('root-turn', 'work'),
  );
  await runtime.enqueue(
    { chatId: 'child-chat', userId: 'user-1' },
    userTurn('child-turn', 'work'),
  );
  await using worker = await runtime.work();
  void worker;
  await h.queue.runNext();
  await h.queue.runNext();

  const sentence =
    'There are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.';
  assert.ok(
    systemText(prompts.root).includes(sentence),
    `root guidance carries the concurrency sentence:\n${systemText(prompts.root)}`,
  );
  assert.ok(
    systemText(prompts.worker).includes(sentence),
    `child guidance carries the concurrency sentence:\n${systemText(prompts.worker)}`,
  );
});
