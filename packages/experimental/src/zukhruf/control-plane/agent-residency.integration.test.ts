import { type LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { type UIMessage, isToolUIPart, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';

import { InMemoryContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  type AgentDeclaration,
  type AgentHost,
  AgentRuntime,
  AgentThreadLimitError,
  type ConversationId,
  EmbeddedAgentStorage,
  SqliteMailboxStore,
  defineAgent,
  defineStack,
  defineTool,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { ControlledAgentStorage } from '../../testing/controlled-agent-storage.fixture.ts';
import { ControlledTurnQueue } from '../../testing/controlled-turn-queue.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { usage } from '../../testing/usage.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const ROOT = { chatId: 'root-chat', userId: 'user-1' };

/** Conversation metadata as `AgentThread.toMetadata` writes it. */
const threadPathSchema = z.looseObject({
  zukhruf: z.looseObject({ path: z.string() }),
});

/** Holds every pushed turn until the test runs the next one of a chat. */
class HeldTurnQueue extends ControlledTurnQueue {
  async runNextFor(chatId: string): Promise<void> {
    const index = this.turns.findIndex((turn) => turn.chatId === chatId);
    assert.notEqual(index, -1, `expected a queued turn for ${chatId}`);
    const [turn] = this.turns.splice(index, 1);
    assert.ok(turn);
    await this.deliver(turn, this.consumer);
  }
}

type ToolCall = { toolName: string; input: Record<string, unknown> };

/** One model step that calls every tool in `calls` at once. */
function step(calls: readonly ToolCall[]) {
  const chunks: LanguageModelV4StreamPart[] = calls.map((call, index) => ({
    type: 'tool-call',
    toolCallId: `${call.toolName}-${index}-${Math.random()}`,
    toolName: call.toolName,
    input: JSON.stringify(call.input),
  }));
  chunks.push({
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: '' },
    usage,
  });
  return { stream: simulateReadableStream({ chunks }) };
}

function text(value: string) {
  return {
    stream: simulateReadableStream<LanguageModelV4StreamPart>({
      chunks: [
        { type: 'text-start', id: 'text' },
        { type: 'text-delta', id: 'text', delta: value },
        { type: 'text-end', id: 'text' },
        { type: 'finish', finishReason: { unified: 'stop', raw: '' }, usage },
      ],
    }),
  };
}

const spawn = (taskName: string): ToolCall => ({
  toolName: 'spawn_agent',
  input: {
    agent_type: 'worker',
    task_name: taskName,
    message: `work on ${taskName}`,
    fork_turns: 'none',
  },
});

/**
 * A root whose every turn starts with the next scripted step of tool calls
 * (text once the script runs out) and answers its tool results with text,
 * recording every tool result it was shown.
 */
function scriptedRoot(
  worker: AgentDeclaration,
  script: Array<readonly ToolCall[]>,
) {
  const toolResults: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const last = prompt.at(-1);
      if (last?.role === 'tool') {
        for (const part of last.content) {
          if (part.type === 'tool-result') {
            toolResults.push(JSON.stringify(part.output));
          }
        }
        return text('root noted the results');
      }
      const calls = script.shift();
      return calls ? step(calls) : text('root done');
    },
  });
  const root = defineAgent({
    name: 'root',
    model,
    sandbox: buildSandbox,
    instructions: [],
    subagents: [worker],
  });
  return { root, toolResults };
}

function workerAgent(): AgentDeclaration {
  return defineAgent({
    name: 'worker',
    model: new MockLanguageModelV4({ doStream: async () => text('done') }),
    sandbox: buildSandbox,
    instructions: [],
  });
}

async function controlledHost(
  root: AgentDeclaration,
  resources: AsyncDisposableStack,
  maxConcurrentThreadsPerSession: number,
) {
  const store = new InMemoryContextStore();
  const streamStore = resources.adopt(new SqliteStreamStore(':memory:'), (s) =>
    s.close(),
  );
  const mailboxStore = resources.adopt(
    new SqliteMailboxStore(':memory:'),
    (s) => s.close(),
  );
  const queue = new HeldTurnQueue();
  const runtime = resources.use(
    await new AgentRuntime(root).initialize(
      defineStack(async () => ({
        storage: new ControlledAgentStorage({
          store,
          streams: streamsFor(streamStore),
          mailboxStore,
          queue,
        }),
        multiAgent: { maxConcurrentThreadsPerSession },
      })),
    ),
  );
  resources.use(await runtime.work());
  return { runtime, store, streamStore, mailboxStore, queue };
}

/** The tree's members by agent path. */
async function treeOf(
  store: InMemoryContextStore,
  root: ConversationId = ROOT,
): Promise<Map<string, ConversationId>> {
  const chats = await store.listChats({
    userId: root.userId,
    metadata: { key: 'zukhrufTreeId', value: root.chatId },
  });
  return new Map(
    chats.map((chat) => [
      threadPathSchema.parse(chat.metadata).zukhruf.path,
      { chatId: chat.id, userId: chat.userId },
    ]),
  );
}

async function treePaths(store: InMemoryContextStore): Promise<string[]> {
  return [...(await treeOf(store)).keys()].toSorted();
}

async function member(
  store: InMemoryContextStore,
  path: string,
  root: ConversationId = ROOT,
): Promise<ConversationId> {
  const found = (await treeOf(store, root)).get(path);
  assert.ok(found, `no member at ${path}`);
  return found;
}

test('two spawn_agent calls in one step at a limit of 2 admit one child and refuse the other with the Codex error', async () => {
  await using resources = new AsyncDisposableStack();
  const { root, toolResults } = scriptedRoot(workerAgent(), [
    [spawn('first'), spawn('second')],
  ]);
  const host = await controlledHost(root, resources, 2);

  await host.runtime.enqueue(ROOT, userTurn('root-turn', 'spawn two'));
  await host.queue.runNextFor(ROOT.chatId);

  const paths = await treePaths(host.store);
  assert.equal(paths.length, 2, `one child besides the root: ${paths}`);
  assert.deepStrictEqual(
    {
      refusals: toolResults.filter((result) =>
        result.includes('collab spawn failed: agent thread limit reached'),
      ).length,
      queued: host.queue.turns.map((turn) => turn.kind),
    },
    { refusals: 1, queued: ['message'] },
  );
});

test('spawn_agent is refused while an earlier child is still queued, and leaves no chat, message, stream or turn behind', async () => {
  await using resources = new AsyncDisposableStack();
  const { root, toolResults } = scriptedRoot(workerAgent(), [
    [spawn('first')],
    [spawn('second')],
  ]);
  const host = await controlledHost(root, resources, 2);
  await host.runtime.enqueue(ROOT, userTurn('root-turn-1', 'spawn first'));
  await host.queue.runNextFor(ROOT.chatId);
  const streamsBefore = await host.streamStore.listStreamIds();

  await host.runtime.enqueue(ROOT, userTurn('root-turn-2', 'spawn second'));
  await host.queue.runNextFor(ROOT.chatId);

  const chats = await host.store.listChats({ userId: ROOT.userId });
  assert.deepStrictEqual(
    {
      paths: await treePaths(host.store),
      chats: chats.length,
      newStreams: (await host.streamStore.listStreamIds()).filter(
        (id) => !streamsBefore.includes(id),
      ).length,
      queued: host.queue.turns.map((turn) => turn.chatId === ROOT.chatId),
      refused: toolResults
        .at(-1)
        ?.includes('collab spawn failed: agent thread limit reached'),
    },
    {
      paths: ['/root', '/root/first'],
      chats: 2,
      newStreams: 1,
      queued: [false],
      refused: true,
    },
  );
});

/**
 * At a limit of 2, `/root/idle` ran its turn to completion and `/root/busy`
 * holds the one sub-agent slot with a queued turn; then the root runs a turn
 * that makes `act`'s tool calls.
 */
async function actBesideQueuedChild(
  resources: AsyncDisposableStack,
  act: readonly ToolCall[],
) {
  const { root, toolResults } = scriptedRoot(workerAgent(), [
    [spawn('idle')],
    [spawn('busy')],
    act,
  ]);
  const host = await controlledHost(root, resources, 2);
  await host.runtime.enqueue(ROOT, userTurn('spawn-idle', 'spawn idle'));
  await host.queue.runNextFor(ROOT.chatId);
  const idle = await member(host.store, '/root/idle');
  await host.queue.runNextFor(idle.chatId);
  await host.runtime.enqueue(ROOT, userTurn('spawn-busy', 'spawn busy'));
  await host.queue.runNextFor(ROOT.chatId);
  const busy = await member(host.store, '/root/busy');

  await host.runtime.enqueue(ROOT, userTurn('act', 'act on the children'));
  await host.queue.runNextFor(ROOT.chatId);

  const queued = host.queue.turns.map((turn) => ({
    chatId: turn.chatId,
    kind: turn.kind,
  }));
  return { host, toolResults, idle, busy, queued };
}

test('followup_task to an idle child while the tree has no free slot answers the Codex error and writes no mail and no wake', async () => {
  await using resources = new AsyncDisposableStack();
  const { host, toolResults, idle, busy, queued } = await actBesideQueuedChild(
    resources,
    [
      {
        toolName: 'followup_task',
        input: { target: '/root/idle', message: 'again' },
      },
    ],
  );

  assert.deepStrictEqual(
    {
      refused: toolResults
        .at(-1)
        ?.includes('collab tool failed: agent thread limit reached'),
      mail: await host.mailboxStore.hasPending(idle),
      queued,
    },
    {
      refused: true,
      mail: false,
      queued: [{ chatId: busy.chatId, kind: 'message' }],
    },
  );
});

test('followup_task to a child that already holds a slot is admitted at the limit: its mail waits and a wake is queued', async () => {
  await using resources = new AsyncDisposableStack();
  const { host, toolResults, busy, queued } = await actBesideQueuedChild(
    resources,
    [
      {
        toolName: 'followup_task',
        input: { target: '/root/busy', message: 'also this' },
      },
    ],
  );

  assert.deepStrictEqual(
    {
      result: toolResults.at(-1),
      mail: await host.mailboxStore.hasPendingTriggerTurn(busy),
      queued,
    },
    {
      result: JSON.stringify({ type: 'text', value: '' }),
      mail: true,
      queued: [
        { chatId: busy.chatId, kind: 'message' },
        { chatId: busy.chatId, kind: 'mailbox' },
      ],
    },
  );
});

test('send_message to an idle child while the tree has no free slot is accepted as mail and starts no turn', async () => {
  await using resources = new AsyncDisposableStack();
  const { host, toolResults, idle, busy, queued } = await actBesideQueuedChild(
    resources,
    [
      {
        toolName: 'send_message',
        input: { target: '/root/idle', message: 'fyi' },
      },
    ],
  );

  assert.deepStrictEqual(
    {
      result: toolResults.at(-1),
      mail: await host.mailboxStore.hasPending(idle),
      queued,
    },
    {
      result: JSON.stringify({ type: 'text', value: '' }),
      mail: true,
      queued: [{ chatId: busy.chatId, kind: 'message' }],
    },
  );
});

test('a retried spawn_agent of a child whose first turn is still queued returns its path at the limit and queues no second turn', async () => {
  await using resources = new AsyncDisposableStack();
  const { root, toolResults } = scriptedRoot(workerAgent(), [
    [spawn('first')],
    [spawn('first')],
  ]);
  const host = await controlledHost(root, resources, 2);
  await host.runtime.enqueue(ROOT, userTurn('root-turn-1', 'spawn first'));
  await host.queue.runNextFor(ROOT.chatId);

  await host.runtime.enqueue(ROOT, userTurn('root-turn-2', 'spawn it again'));
  await host.queue.runNextFor(ROOT.chatId);

  const first = await member(host.store, '/root/first');
  assert.deepStrictEqual(
    {
      result: toolResults.at(-1),
      queued: host.queue.turns.map((turn) => turn.chatId),
    },
    {
      result: JSON.stringify({
        type: 'json',
        value: { task_name: '/root/first' },
      }),
      queued: [first.chatId],
    },
  );
});

/** Approves every tool call of the conversation's head that waits for approval. */
async function approveAll(runtime: AgentHost, conversation: ConversationId) {
  const head = (await runtime.observe(conversation).engine.getMessages()).at(
    -1,
  );
  assert.equal(head?.role, 'assistant');
  const message: UIMessage & { role: 'assistant' } = {
    ...head,
    role: 'assistant',
    parts: head.parts.map((part) =>
      isToolUIPart(part) && part.state === 'approval-requested'
        ? {
            ...part,
            state: 'approval-responded',
            approval: { ...part.approval, approved: true },
          }
        : part,
    ),
  };
  await runtime.enqueue(conversation, { message, trigger: 'submit-message' });
}

test('a child paused on an approval holds its slot until its continuation completes', async () => {
  await using resources = new AsyncDisposableStack();
  let workerCalls = 0;
  const worker = defineAgent({
    name: 'worker',
    model: new MockLanguageModelV4({
      doStream: async () =>
        ++workerCalls === 1
          ? step([{ toolName: 'publish', input: { report: 'findings' } }])
          : text('published'),
    }),
    sandbox: buildSandbox,
    instructions: [],
    toolApproval: { publish: 'user-approval' },
    tools: {
      publish: defineTool({
        description: 'Publish the report',
        inputSchema: z.object({ report: z.string() }),
        execute: async ({ report }) => report,
      }),
    },
  });
  const { root, toolResults } = scriptedRoot(worker, [
    [spawn('paused')],
    [spawn('second')],
    [spawn('second')],
  ]);
  const host = await controlledHost(root, resources, 2);
  await host.runtime.enqueue(ROOT, userTurn('spawn-paused', 'spawn paused'));
  await host.queue.runNextFor(ROOT.chatId);
  const paused = await member(host.store, '/root/paused');
  await host.queue.runNextFor(paused.chatId);

  await host.runtime.enqueue(ROOT, userTurn('spawn-held', 'spawn while held'));
  await host.queue.runNextFor(ROOT.chatId);
  const whilePaused = {
    refused: toolResults
      .at(-1)
      ?.includes('collab spawn failed: agent thread limit reached'),
    paths: await treePaths(host.store),
  };
  await approveAll(host.runtime, paused);
  await host.queue.runNextFor(paused.chatId);
  await host.runtime.enqueue(ROOT, userTurn('spawn-freed', 'spawn when freed'));
  await host.queue.runNextFor(ROOT.chatId);

  assert.deepStrictEqual(
    {
      whilePaused,
      afterContinuation: {
        accepted: toolResults.at(-1)?.includes('/root/second'),
        paths: await treePaths(host.store),
      },
    },
    {
      whilePaused: { refused: true, paths: ['/root', '/root/paused'] },
      afterContinuation: {
        accepted: true,
        paths: ['/root', '/root/paused', '/root/second'],
      },
    },
  );
});

test('POST /session answers 429 for an idle sub-agent while a queued sibling holds the last slot, queues nothing for it, and still accepts the root', async () => {
  await using resources = new AsyncDisposableStack();
  const root = { chatId: randomUUID(), userId: 'user-1' };
  const { root: declaration } = scriptedRoot(workerAgent(), [
    [spawn('idle')],
    [spawn('busy')],
  ]);
  const host = await controlledHost(declaration, resources, 2);
  await host.runtime.enqueue(root, userTurn('spawn-idle', 'spawn idle'));
  await host.queue.runNextFor(root.chatId);
  const idle = await member(host.store, '/root/idle', root);
  await host.queue.runNextFor(idle.chatId);
  await host.runtime.enqueue(root, userTurn('spawn-busy', 'spawn busy'));
  await host.queue.runNextFor(root.chatId);
  const busy = await member(host.store, '/root/busy', root);
  const app = new Hono<HttpEnv>();
  app.use('/zukhruf/v1/*', (context, next) => {
    context.set('userId', 'user-1');
    return next();
  });
  app.route('/zukhruf/v1', http(host.runtime));
  const post = (sessionId: string) =>
    app.request(`/zukhruf/v1/session/${sessionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message: {
          id: `message-${randomUUID()}`,
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
        trigger: 'submit-message',
      }),
    });

  const refused = await post(idle.chatId);
  const rootAccepted = await post(root.chatId);

  assert.deepStrictEqual(
    {
      status: refused.status,
      body: await refused.json(),
      rootStatus: rootAccepted.status,
      queued: host.queue.turns.map((turn) => turn.chatId),
    },
    {
      status: 429,
      body: {
        error: 'Agent thread limit reached',
        cause: {
          code: 'zukhruf/agent-thread-limit',
          detail: `Every agent slot of session ${idle.chatId}'s tree is busy; retry when one finishes`,
        },
      },
      rootStatus: 202,
      queued: [busy.chatId, root.chatId],
    },
  );
});

test('on EmbeddedAgentStorage, a turn for an idle child is refused with AgentThreadLimitError while a sibling turn waits, and the root is still admitted', async (t) => {
  await using directory = await new TemporaryFiles().directory('residency-');
  const { root } = scriptedRoot(workerAgent(), [
    [spawn('first'), spawn('second')],
  ]);
  {
    // Arrange two idle children at a limit that lets both run.
    await using storage = await EmbeddedAgentStorage.open({
      directory: directory.path,
    });
    await using runtime = await new AgentRuntime(root).initialize(
      defineStack(async () => ({
        storage,
        multiAgent: { maxConcurrentThreadsPerSession: 3 },
      })),
    );
    await using worker = await runtime.work();
    void worker;
    await runtime.enqueue(ROOT, userTurn('spawn-both', 'spawn both'));
    await waitFor(
      async () => {
        const children = (await runtime.listHistory(ROOT.userId))
          .find((item) => item.chatId === ROOT.chatId)
          ?.children?.map((child) => child.state);
        assert.deepStrictEqual(children, ['completed', 'completed']);
      },
      { signal: t.signal },
    );
  }
  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  await using runtime = await new AgentRuntime(root).initialize(
    defineStack(async () => ({
      storage,
      multiAgent: { maxConcurrentThreadsPerSession: 2 },
    })),
  );
  const children = new Map(
    ((await runtime.listHistory(ROOT.userId))[0]?.children ?? []).map(
      (child) => [child.path, { chatId: child.chatId, userId: ROOT.userId }],
    ),
  );
  const first = children.get('/root/first');
  const second = children.get('/root/second');
  assert.ok(first && second);

  await runtime.enqueue(first, userTurn('first-again', 'go'));
  const refused = await runtime
    .enqueue(second, userTurn('second-again', 'go'))
    .then(
      () => 'admitted',
      (error: unknown) =>
        error instanceof AgentThreadLimitError ? 'refused' : String(error),
    );
  await runtime.enqueue(ROOT, userTurn('root-again', 'the root is free'));

  assert.deepStrictEqual(
    {
      refused,
      activity: await Promise.all(
        [first, second, ROOT].map((conversation) =>
          storage.queue.getTurnActivity(conversation),
        ),
      ),
    },
    { refused: 'refused', activity: ['queued', 'idle', 'queued'] },
  );
});
