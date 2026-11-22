import type { LanguageModelV4FunctionTool } from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  type BashToolkitTools,
  InMemoryContextStore,
  SqliteStreamStore,
} from '@deepagents/context';
import {
  type AgentHost,
  AgentRuntime,
  CodeModeTools,
  DirectTools,
  MessageDeliveryModes,
  Spawning,
  SqliteMailboxStore,
  Supervision,
  Team,
  ToolNamespace,
  WaitBounds,
  Waiting,
  createInterAgentCommunication,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { ControlledAgentStorage } from '../../testing/controlled-agent-storage.fixture.ts';
import { ControlledTurnQueue } from '../../testing/controlled-turn-queue.fixture.ts';
import {
  textResult,
  toolCallResult,
} from '../../testing/stream-results.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

function toolCallResponse(toolName: string, input: unknown) {
  return toolCallResult({
    toolCallId: `call-${toolName}`,
    toolName,
    input: JSON.stringify(input),
  });
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

/** Every `virtualSandbox` contributes these; assertions look past them. */
const SANDBOX_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'readFile',
  'writeFile',
] satisfies (keyof BashToolkitTools)[]);

/** Function tools the model sees, apart from the sandbox's own. */
function functionTools(tools: unknown): LanguageModelV4FunctionTool[] {
  return Array.isArray(tools)
    ? tools.filter(
        (candidate): candidate is LanguageModelV4FunctionTool =>
          typeof candidate === 'object' &&
          candidate !== null &&
          'type' in candidate &&
          candidate.type === 'function' &&
          'name' in candidate &&
          typeof candidate.name === 'string' &&
          !SANDBOX_TOOLS.has(candidate.name),
      )
    : [];
}

function harness() {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const streams = streamsFor(streamStore);
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  return {
    store,
    streams,
    streamStore,
    mailboxStore,
    queue,
    [Symbol.dispose]() {
      streamStore.close();
      mailboxStore.close();
    },
  };
}

test('a team injects root guidance, spawn guidance, namespace, and wait bounds', async () => {
  using h = harness();
  let request: { prompt: unknown; tools: unknown } | undefined;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt, tools }) => {
      request = { prompt, tools };
      return textResult('done');
    },
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model,
      sandbox: buildSandbox(),
      instructions: [],
      subagents: [
        defineAgent({
          name: 'reviewer',
          description: 'Reviews the current change.',
          model,
          sandbox: buildSandbox(),
          instructions: [],
        }),
        defineAgent({
          name: 'worker',
          model,
          sandbox: buildSandbox(),
          instructions: [],
        }),
      ],
    }),
  );
  const runtimeStack = defineStack(async () => ({
    storage: new ControlledAgentStorage(h),
    multiAgent: Team.codex({
      usageHintText: 'Prefer delegation for independent work.',
      waitBounds: new WaitBounds({ minMs: 111, defaultMs: 222, maxMs: 333 }),
      exposure: new DirectTools(new ToolNamespace('agents')),
      guidance: {
        root: () => 'ROOT COLLABORATION GUIDANCE',
        subagent: () => 'CHILD COLLABORATION GUIDANCE',
      },
    }),
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack);
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
  const timeoutSchema = wait?.inputSchema.properties?.timeout_ms;
  assert.ok(typeof timeoutSchema === 'object');
  assert.equal(timeoutSchema.maximum, 333);
});

test('wait_agent clamps a below-minimum timeout and reports it to the model', async () => {
  const store = new InMemoryContextStore();
  const streamStore = new SqliteStreamStore(':memory:');
  const streams = streamsFor(streamStore);
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const queue = new ControlledTurnQueue();
  const conversation = { chatId: 'root-chat', userId: 'user-1' };
  let runtime: AgentHost;
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
            MessageDeliveryModes.QueueOnly,
          ),
        );
        return toolCallResponse('wait_agent', { timeout_ms: 1 });
      }
      promptAfterWait = prompt;
      return textResult('continued');
    },
  });

  try {
    const runtimeSetup = new AgentRuntime(
      defineAgent({
        name: 'root',
        model,
        sandbox: buildSandbox(),
        instructions: [],
      }),
    );
    const runtimeStack2 = defineStack(async () => ({
      storage: new ControlledAgentStorage({
        store,
        streams,
        mailboxStore,
        queue,
      }),
      multiAgent: Team.codex({
        waitBounds: new WaitBounds({ minMs: 50, defaultMs: 75, maxMs: 100 }),
      }),
    }));
    runtime = await runtimeSetup.initialize(runtimeStack2);
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

test('subagent guidance replaces root guidance on a child turn', async () => {
  using h = harness();
  let childPrompt: unknown;
  const child = defineAgent({
    name: 'worker',
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        childPrompt = prompt;
        return textResult('done');
      },
    }),
    sandbox: buildSandbox(),
    instructions: [],
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: child.model,
      sandbox: child.sandbox,
      instructions: [],
      subagents: [child],
    }),
  );
  const runtimeStack3 = defineStack(async () => ({
    storage: new ControlledAgentStorage(h),
    multiAgent: Team.codex({
      guidance: {
        root: () => 'ROOT COLLABORATION GUIDANCE',
        subagent: () => 'CHILD COLLABORATION GUIDANCE',
      },
    }),
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack3);
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

test('spawn output is the canonical task name without agent_path', async () => {
  using h = harness();
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
      return textResult('spawned');
    },
  });
  const child = defineAgent({
    name: 'worker',
    model,
    sandbox: buildSandbox(),
    instructions: [],
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model,
      sandbox: child.sandbox,
      instructions: [],
      subagents: [child],
    }),
  );
  const runtimeStack = defineStack(async () => ({
    storage: new ControlledAgentStorage(h),
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack);
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

test('plugin-contributed subagent uses AI SDK code mode collaboration', async () => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-code-mode-',
  );
  await writeFile(
    join(directory.path, 'reviewer.md'),
    `---\nname: reviewer\ndescription: Reviews the current change.\n---\n\nReview the implementation.\n`,
  );

  using h = harness();
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
      return textResult('done');
    },
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model,
      sandbox: buildSandbox(),
      instructions: [],
      plugins: [
        {
          name: 'engineering',
          create: () => ({ agents: [directory.path] }),
        },
      ],
    }),
  );
  const runtimeStack4 = defineStack(async () => ({
    storage: new ControlledAgentStorage(h),
    multiAgent: Team.codex({ exposure: new CodeModeTools() }),
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack4);

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

test('interrupt_agent reports not_found for a missing target', async () => {
  using h = harness();
  let calls = 0;
  let prompt: unknown;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt: currentPrompt }) => {
      calls++;
      if (calls === 1) {
        return toolCallResponse('interrupt_agent', { target: 'missing' });
      }
      prompt = currentPrompt;
      return textResult('done');
    },
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model,
      sandbox: buildSandbox(),
      instructions: [],
    }),
  );
  const runtimeStack = defineStack(async () => ({
    storage: new ControlledAgentStorage(h),
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack);
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    userTurn('root-turn', 'interrupt missing'),
  );
  await using worker = await runtime.work();
  void worker;
  await h.queue.runNext();

  assert.match(JSON.stringify(prompt), /"previous_status":"not_found"/);
});

test('team parts reject invalid namespaces, wait bounds, and concurrency', () => {
  assert.throws(
    () => new ToolNamespace('functions'),
    /reserved tool namespace/,
  );
  assert.throws(
    () => new ToolNamespace(' agents '),
    /cannot be empty or padded/,
  );
  assert.throws(
    () => new WaitBounds({ minMs: 50, defaultMs: 40, maxMs: 100 }),
    /defaultMs must be at least minMs/,
  );
  assert.throws(
    () => Team.codex({ maxConcurrentThreads: 0 }),
    /maxConcurrentThreads must be a positive integer/,
  );
});

test('default guidance tells root and child agents the Codex concurrency slots', async () => {
  using h = harness();
  const prompts: Record<string, unknown> = {};
  const capturing = (name: string) =>
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts[name] = prompt;
        return textResult('done');
      },
    });
  const child = defineAgent({
    name: 'worker',
    model: capturing('worker'),
    sandbox: buildSandbox(),
    instructions: [],
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: capturing('root'),
      sandbox: child.sandbox,
      instructions: [],
      subagents: [child],
    }),
  );
  const runtimeStack = defineStack(async () => ({
    storage: new ControlledAgentStorage(h),
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack);
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

async function guidanceFor(multiAgent: Team) {
  using h = harness();
  const requests: Record<string, { prompt: unknown; tools: unknown }> = {};
  const capturing = (name: string) =>
    new MockLanguageModelV4({
      doStream: async ({ prompt, tools }) => {
        requests[name] = { prompt, tools };
        return textResult('done');
      },
    });
  const child = defineAgent({
    name: 'worker',
    model: capturing('worker'),
    sandbox: buildSandbox(),
    instructions: [],
  });
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: capturing('root'),
      sandbox: child.sandbox,
      instructions: [],
      subagents: [child],
    }),
  );
  const runtimeStack = defineStack(async () => ({
    storage: new ControlledAgentStorage(h),
    multiAgent,
  }));
  const runtime = await runtimeSetup.initialize(runtimeStack);
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

  return {
    root: systemText(requests.root?.prompt),
    subagent: systemText(requests.worker?.prompt),
    rootTools: functionTools(requests.root?.tools).map(({ name }) => name),
    subagentTools: functionTools(requests.worker?.tools).map(
      ({ name }) => name,
    ),
  };
}

test('direct collaboration tools: root and subagent receive the full default guidance and tools in request order', async () => {
  const actual = await guidanceFor(Team.codex());

  assert.deepStrictEqual(actual, {
    root: [
      '<role>',
      '  You are `/root`, the primary agent in a team of agents collaborating to fulfill the user&apos;s goals.',
      '  ',
      '  At the start of your turn, you are the active agent. You can spawn sub-agents to handle subtasks, and those agents can recursively spawn their own declared sub-agents. All agents are equally capable and receive the tools declared for their agent type.',
      '  ',
      '  Use `spawn_agent` to create an agent, `followup_task` to assign a new task and trigger a turn, and `send_message` to queue a message without triggering a turn. You can decide how much context you want to propagate to your sub-agents with the `fork_turns` parameter.',
      '  ',
      '  Child messages arrive as `MESSAGE` or `FINAL_ANSWER` mailbox envelopes with their task name, sender, and payload preserved.',
      '  ',
      '  Call `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents` directly. They are intentionally unavailable inside nested code execution.',
      '  ',
      '  All agents share the same workspace, current working directory, and filesystem.',
      '  ',
      '  When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.',
      '  ',
      '  There are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.',
      '</role>',
    ].join('\n'),
    subagent: [
      '<role>',
      '  You are an agent in a team collaborating to complete a task.',
      '  ',
      '  You can spawn declared sub-agents recursively. All agents are equally capable and receive the tools declared for their agent type. Use `spawn_agent` to create one, `followup_task` to assign a new task and trigger a turn, and `send_message` to queue a message for another agent.',
      '  ',
      '  Your final response is delivered automatically to your parent agent. Mailbox messages arrive as `NEW_TASK`, `MESSAGE`, or `FINAL_ANSWER` envelopes with their task name, sender, and payload preserved.',
      '  ',
      '  Call `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents` directly. They are intentionally unavailable inside nested code execution.',
      '  ',
      '  All agents share the same workspace, current working directory, and filesystem.',
      '  ',
      '  When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.',
      '  ',
      '  There are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.',
      '</role>',
    ].join('\n'),
    rootTools: [
      'spawn_agent',
      'send_message',
      'followup_task',
      'wait_agent',
      'interrupt_agent',
      'list_agents',
    ],
    subagentTools: [
      'spawn_agent',
      'send_message',
      'followup_task',
      'wait_agent',
      'interrupt_agent',
      'list_agents',
    ],
  });
});

test('namespaced collaboration tools: root and subagent receive the full default guidance and tools in request order', async () => {
  const actual = await guidanceFor(
    Team.codex({ exposure: new DirectTools(new ToolNamespace('agents')) }),
  );

  assert.deepStrictEqual(actual, {
    root: [
      '<role>',
      '  You are `/root`, the primary agent in a team of agents collaborating to fulfill the user&apos;s goals.',
      '  ',
      '  At the start of your turn, you are the active agent. You can spawn sub-agents to handle subtasks, and those agents can recursively spawn their own declared sub-agents. All agents are equally capable and receive the tools declared for their agent type.',
      '  ',
      '  Use `agents.spawn_agent` to create an agent, `agents.followup_task` to assign a new task and trigger a turn, and `agents.send_message` to queue a message without triggering a turn. You can decide how much context you want to propagate to your sub-agents with the `fork_turns` parameter.',
      '  ',
      '  Child messages arrive as `MESSAGE` or `FINAL_ANSWER` mailbox envelopes with their task name, sender, and payload preserved.',
      '  ',
      '  Call `agents.spawn_agent`, `agents.send_message`, `agents.followup_task`, `agents.wait_agent`, `agents.interrupt_agent`, `agents.list_agents` directly. They are intentionally unavailable inside nested code execution.',
      '  ',
      '  All agents share the same workspace, current working directory, and filesystem.',
      '  ',
      '  When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.',
      '  ',
      '  There are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.',
      '</role>',
    ].join('\n'),
    subagent: [
      '<role>',
      '  You are an agent in a team collaborating to complete a task.',
      '  ',
      '  You can spawn declared sub-agents recursively. All agents are equally capable and receive the tools declared for their agent type. Use `agents.spawn_agent` to create one, `agents.followup_task` to assign a new task and trigger a turn, and `agents.send_message` to queue a message for another agent.',
      '  ',
      '  Your final response is delivered automatically to your parent agent. Mailbox messages arrive as `NEW_TASK`, `MESSAGE`, or `FINAL_ANSWER` envelopes with their task name, sender, and payload preserved.',
      '  ',
      '  Call `agents.spawn_agent`, `agents.send_message`, `agents.followup_task`, `agents.wait_agent`, `agents.interrupt_agent`, `agents.list_agents` directly. They are intentionally unavailable inside nested code execution.',
      '  ',
      '  All agents share the same workspace, current working directory, and filesystem.',
      '  ',
      '  When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.',
      '  ',
      '  There are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.',
      '</role>',
    ].join('\n'),
    rootTools: [
      'spawn_agent',
      'send_message',
      'followup_task',
      'wait_agent',
      'interrupt_agent',
      'list_agents',
    ],
    subagentTools: [
      'spawn_agent',
      'send_message',
      'followup_task',
      'wait_agent',
      'interrupt_agent',
      'list_agents',
    ],
  });
});

test('code-mode collaboration tools: root and subagent receive the full default guidance and tools in request order', async () => {
  const actual = await guidanceFor(
    Team.codex({ exposure: new CodeModeTools() }),
  );

  assert.deepStrictEqual(actual, {
    root: [
      '<role>',
      '  You are `/root`, the primary agent in a team of agents collaborating to fulfill the user&apos;s goals.',
      '  ',
      '  At the start of your turn, you are the active agent. You can spawn sub-agents to handle subtasks, and those agents can recursively spawn their own declared sub-agents. All agents are equally capable and receive the tools declared for their agent type.',
      '  ',
      '  Use `tools.spawn_agent` to create an agent, `tools.followup_task` to assign a new task and trigger a turn, and `tools.send_message` to queue a message without triggering a turn. You can decide how much context you want to propagate to your sub-agents with the `fork_turns` parameter.',
      '  ',
      '  Child messages arrive as `MESSAGE` or `FINAL_ANSWER` mailbox envelopes with their task name, sender, and payload preserved.',
      '  ',
      '  Call `tools.spawn_agent`, `tools.send_message`, `tools.followup_task`, `tools.wait_agent`, `tools.interrupt_agent`, `tools.list_agents` from `code_mode`.',
      '  ',
      '  All agents share the same workspace, current working directory, and filesystem.',
      '  ',
      '  When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.',
      '  ',
      '  There are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.',
      '</role>',
    ].join('\n'),
    subagent: [
      '<role>',
      '  You are an agent in a team collaborating to complete a task.',
      '  ',
      '  You can spawn declared sub-agents recursively. All agents are equally capable and receive the tools declared for their agent type. Use `tools.spawn_agent` to create one, `tools.followup_task` to assign a new task and trigger a turn, and `tools.send_message` to queue a message for another agent.',
      '  ',
      '  Your final response is delivered automatically to your parent agent. Mailbox messages arrive as `NEW_TASK`, `MESSAGE`, or `FINAL_ANSWER` envelopes with their task name, sender, and payload preserved.',
      '  ',
      '  Call `tools.spawn_agent`, `tools.send_message`, `tools.followup_task`, `tools.wait_agent`, `tools.interrupt_agent`, `tools.list_agents` from `code_mode`.',
      '  ',
      '  All agents share the same workspace, current working directory, and filesystem.',
      '  ',
      '  When calling `wait_agent`, prefer longer waits (minutes) to avoid busy polling.',
      '  ',
      '  There are 4 available concurrency slots, meaning that up to 4 agents can be active at once, including you.',
      '</role>',
    ].join('\n'),
    rootTools: ['code_mode'],
    subagentTools: ['code_mode'],
  });
});

const withoutDirectMessaging = (options?: { exposure: CodeModeTools }) =>
  new Team(new Spawning(), options).with(new Supervision()).with(new Waiting());

test('a team without direct messaging offers neither its tools nor their guidance', async () => {
  const actual = await guidanceFor(withoutDirectMessaging());

  assert.deepStrictEqual(
    {
      rootTools: actual.rootTools,
      subagentTools: actual.subagentTools,
      rootMentionsMessaging: /send_message|followup_task/.test(actual.root),
      subagentMentionsMessaging: /send_message|followup_task/.test(
        actual.subagent,
      ),
      rootUses: actual.root.includes(
        'Use `spawn_agent` to create an agent. You can decide',
      ),
      subagentUses: actual.subagent.includes(
        'Use `spawn_agent` to create one.\n',
      ),
    },
    {
      rootTools: [
        'spawn_agent',
        'interrupt_agent',
        'list_agents',
        'wait_agent',
      ],
      subagentTools: [
        'spawn_agent',
        'interrupt_agent',
        'list_agents',
        'wait_agent',
      ],
      rootMentionsMessaging: false,
      subagentMentionsMessaging: false,
      rootUses: true,
      subagentUses: true,
    },
  );
});

test('a code-mode team without direct messaging gives the missing tools no caller', async () => {
  const team = withoutDirectMessaging({ exposure: new CodeModeTools() });
  const actual = await guidanceFor(team);

  assert.deepStrictEqual(
    {
      rootTools: actual.rootTools,
      subagentTools: actual.subagentTools,
      rootMentionsMessaging: /send_message|followup_task/.test(actual.root),
      subagentMentionsMessaging: /send_message|followup_task/.test(
        actual.subagent,
      ),
      rootUses: actual.root.includes(
        'Use `tools.spawn_agent` to create an agent. You can decide',
      ),
      calledFromCodeMode: Object.keys(team.surface.toolCallers ?? {}),
    },
    {
      rootTools: ['code_mode'],
      subagentTools: ['code_mode'],
      rootMentionsMessaging: false,
      subagentMentionsMessaging: false,
      rootUses: true,
      calledFromCodeMode: [
        'spawn_agent',
        'interrupt_agent',
        'list_agents',
        'wait_agent',
      ],
    },
  );
});

test("a child's FINAL_ANSWER reaches the root of a team without direct messaging", async () => {
  using h = harness();
  const rootPrompts: unknown[] = [];
  const root = defineAgent({
    name: 'root',
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        rootPrompts.push(prompt);
        return rootPrompts.length === 1
          ? toolCallResponse('spawn_agent', {
              agent_type: 'worker',
              task_name: 'research',
              message: 'Find the answer',
              fork_turns: 'none',
            })
          : textResult('root done');
      },
    }),
    sandbox: buildSandbox(),
    instructions: [],
    subagents: [
      defineAgent({
        name: 'worker',
        model: new MockLanguageModelV4({
          doStream: async () => textResult('child result'),
        }),
        sandbox: buildSandbox(),
        instructions: [],
      }),
    ],
  });
  const runtime = await new AgentRuntime(root).initialize(
    defineStack(async () => ({
      storage: new ControlledAgentStorage(h),
      multiAgent: withoutDirectMessaging(),
    })),
  );
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    userTurn('root-turn', 'delegate'),
  );
  await using worker = await runtime.work();
  void worker;
  await h.queue.runNext();
  await h.queue.runNext();
  await runtime.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    userTurn('root-turn-2', 'report'),
  );
  await h.queue.runNext();

  const lastRootPrompt = JSON.stringify(rootPrompts.at(-1));
  assert.match(lastRootPrompt, /Message Type: FINAL_ANSWER/);
  assert.match(lastRootPrompt, /child result/);
});
