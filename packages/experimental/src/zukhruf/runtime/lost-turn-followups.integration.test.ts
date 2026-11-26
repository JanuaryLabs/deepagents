import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { untilAborted } from '@zukhruf/async';
import { waitFor } from '@zukhruf/testing/async';
import {
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
  isTextUIPart,
  isToolUIPart,
  readUIMessageStream,
  simulateReadableStream,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import { InMemoryContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  type AgentDeclaration,
  type AgentHost,
  AgentRuntime,
  type ConversationStatus,
  PgBossTurnQueue,
  SqliteMailboxStore,
  type TurnRef,
  defineAgent,
  defineStack,
  defineTool,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { ControlledAgentStorage } from '../../testing/controlled-agent-storage.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { usage } from '../../testing/usage.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const turn = (text: string) => userTurn(`message:${crypto.randomUUID()}`, text);

const LOST_TURN_ERROR = 'turn lost: its queue job was deleted before it ran';

function lastUserText(prompt: LanguageModelV4Prompt): string {
  const lastUser = prompt
    .flatMap((message) => (message.role === 'user' ? [message] : []))
    .at(-1);
  return (
    lastUser?.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('') ?? ''
  );
}

/**
 * Asks containing "send" call the approval-gated `sendEmail` tool on their
 * first model call and answer `done:<ask>` once its result is visible; other
 * asks reply `reply:<ask>`.
 */
function approvalSetup() {
  const track: { calls: string[]; toolRuns: number } = {
    calls: [],
    toolRuns: 0,
  };
  const tools: ToolSet = {
    sendEmail: defineTool({
      description: 'Send an email',
      inputSchema: z.object({ to: z.string() }),
      execute: async ({ to }) => {
        track.toolRuns++;
        return `sent:${to}`;
      },
    }),
  };
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      track.calls.push(text);
      const firstCallForAsk =
        track.calls.filter((call) => call === text).length === 1;
      const reply = !text.includes('send')
        ? `reply:${text}`
        : firstCallForAsk
          ? undefined
          : JSON.stringify(prompt).includes('sent:')
            ? `done:${text}`
            : `denied:${text}`;
      const chunks: LanguageModelV4StreamPart[] =
        reply === undefined
          ? [
              {
                type: 'tool-call',
                toolCallId: `tc-${text.replaceAll(' ', '_')}`,
                toolName: 'sendEmail',
                input: JSON.stringify({ to: 'a@b.c' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: '' },
                usage,
              },
            ]
          : [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: reply },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  const agent: AgentDeclaration = {
    name: 'test-agent',
    model,
    sandbox: buildSandbox(),
    instructions: [],
    tools,
    toolApproval: { sendEmail: 'user-approval' },
  };
  return { track, agent };
}

async function harness(declaration: AgentDeclaration) {
  await using resources = new AsyncDisposableStack();
  const pglite = resources.adopt(new PGlite(), (database) => database.close());
  const boss = resources.adopt(
    new PgBoss({
      db: fromPglite(pglite),
      backend: 'pglite',
      maintenanceIntervalSeconds: 1,
    }),
    (value) => value.stop({ graceful: false }),
  );
  boss.on('error', () => {});
  await boss.start();
  const queue = await PgBossTurnQueue.create(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (value) => value.close(),
  );
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  const stack = defineStack(async () => ({
    storage: new ControlledAgentStorage({
      store: new InMemoryContextStore(),
      streams: streamsFor(streamStore),
      queue,
      mailboxStore,
    }),
  }));
  const runtime = resources.use(
    await new AgentRuntime(declaration).initialize(stack),
  );
  const owned = resources.move();
  return {
    runtime,
    streamStore,
    boss,
    queue,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

async function collectText(stream: ReadableStream<UIMessageChunk>) {
  let message: UIMessage | undefined;
  for await (const streamed of readUIMessageStream({ stream })) {
    message = streamed;
  }
  return (
    message?.parts
      .filter(isTextUIPart)
      .map((part) => part.text)
      .join('') ?? ''
  );
}

async function pausedToolCallId(
  runtime: AgentHost,
  conversation: { chatId: string; userId: string },
): Promise<string> {
  const head = (await runtime.observe(conversation).engine.getMessages()).at(
    -1,
  );
  const part = head?.parts.find(isToolUIPart);
  assert.ok(part, 'the head waits on a tool approval');
  return part.toolCallId;
}

async function approve(
  runtime: AgentHost,
  conversation: { chatId: string; userId: string },
  toolCallId: string,
) {
  const head = (await runtime.observe(conversation).engine.getMessages()).at(
    -1,
  );
  assert.equal(head?.role, 'assistant');
  return runtime.enqueue(conversation, {
    message: {
      ...head,
      role: 'assistant',
      parts: head.parts.map((part) =>
        isToolUIPart(part) &&
        part.state === 'approval-requested' &&
        part.toolCallId === toolCallId
          ? {
              ...part,
              state: 'approval-responded',
              approval: { ...part.approval, approved: true },
            }
          : part,
      ),
    },
    trigger: 'submit-message',
  });
}

/** The statuses published for `conversation`, from now until `signal` aborts. */
function recordStatuses(
  runtime: AgentHost,
  conversation: { chatId: string; userId: string },
  signal: AbortSignal,
) {
  const seen: ConversationStatus[] = [];
  const done = (async () => {
    try {
      for await (const change of await runtime.subscribeConversationStatus(
        signal,
      )) {
        if (
          change.type === 'change' &&
          change.conversation.chatId === conversation.chatId
        ) {
          seen.push(change.status);
        }
      }
    } catch (error) {
      if (!(Error.isError(error) && error.name === 'AbortError')) throw error;
    }
  })();
  return { seen, done };
}

describe('zukhruf runtime — a lost approval continuation', () => {
  it('publishes the waiting-on-approval status its failure leaves, and keeps its follow-up parked until the approval is answered again', async (t) => {
    const { track, agent } = approvalSetup();
    await using h = await harness(agent);
    const conversation = {
      chatId: 'lost-continuation-follow-up',
      userId: 'u1',
    };
    const followUp = await (async () => {
      await using _worker = await h.runtime.work();
      void _worker;
      await collectText(
        (await h.runtime.enqueue(conversation, turn('send it'))).stream,
      );
      const queued = await h.runtime.enqueue(conversation, turn('two'));
      await waitFor(
        async () =>
          assert.deepStrictEqual(
            (
              await h.boss.findJobs(h.queue.queue, {
                data: { streamId: queued.id },
              })
            ).map((job) => job.state),
            ['cancelled'],
          ),
        { interval: 20, signal: t.signal },
      );
      return queued;
    })();
    await h.boss.updateQueue(h.queue.queue, { retentionSeconds: 1 });
    const toolCallId = await pausedToolCallId(h.runtime, conversation);
    const continuation = await approve(h.runtime, conversation, toolCallId);
    await waitFor(
      async () => {
        await h.boss.supervise(h.queue.queue);
        assert.deepStrictEqual(
          await h.boss.findJobs(h.queue.queue, {
            data: { streamId: continuation.id },
          }),
          [],
        );
      },
      { interval: 100, signal: t.signal },
    );
    const abort = new AbortController();
    const { seen, done } = recordStatuses(
      h.runtime,
      conversation,
      abort.signal,
    );
    try {
      await using _worker = await h.runtime.work();
      void _worker;

      assert.deepStrictEqual(
        await untilAborted(Array.fromAsync(continuation.stream), t.signal),
        [{ type: 'error', errorText: LOST_TURN_ERROR }],
      );
      const waiting: ConversationStatus = {
        type: 'active',
        activeFlags: ['waitingOnApproval'],
      };
      assert.deepStrictEqual(
        await h.runtime.observe(conversation).conversationStatus(),
        waiting,
        'the lost continuation never answered the approval',
      );
      await waitFor(() => assert.deepStrictEqual(seen, [waiting]), {
        interval: 25,
        signal: t.signal,
      });

      assert.deepStrictEqual(
        (
          await h.boss.findJobs(h.queue.queue, {
            data: { streamId: followUp.id },
          })
        ).map((job) => job.state),
        ['cancelled'],
        'the follow-up stays parked behind the unanswered approval',
      );

      await approve(h.runtime, conversation, toolCallId);
      assert.equal(
        await untilAborted(collectText(followUp.stream), t.signal),
        'reply:two',
      );
      assert.deepStrictEqual(track.calls, ['send it', 'send it', 'two']);
      assert.equal(track.toolRuns, 1);
    } finally {
      abort.abort();
      await done;
    }
  });
});

describe('zukhruf runtime — a lost child-agent continuation', () => {
  it("sends the parent the child's completion with the lost-turn error, once, and records it", async (t) => {
    const rootPrompts: LanguageModelV4Prompt[] = [];
    const sandbox = buildSandbox();
    const respond = (chunks: LanguageModelV4StreamPart[]) => ({
      stream: simulateReadableStream({ chunks }),
    });
    const text = (value: string): LanguageModelV4StreamPart[] => [
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: value },
      { type: 'text-end', id: 't1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: '' }, usage },
    ];
    const call = (toolName: string, input: unknown) =>
      respond([
        {
          type: 'tool-call',
          toolCallId: `tc-${toolName}`,
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: '' },
          usage,
        },
      ]);
    const root = defineAgent({
      name: 'root',
      sandbox,
      instructions: [],
      model: new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          rootPrompts.push(prompt);
          return rootPrompts.length === 1
            ? call('spawn_agent', {
                agent_type: 'researcher',
                task_name: 'research',
                message: 'Research and publish',
              })
            : respond(text(`root:${lastUserText(prompt)}`));
        },
      }),
      subagents: [
        defineAgent({
          name: 'researcher',
          sandbox,
          instructions: [],
          toolApproval: { publish: 'user-approval' },
          tools: {
            publish: defineTool({
              description: 'Publish the report',
              inputSchema: z.object({}),
              execute: async () => 'published',
            }),
          },
          model: new MockLanguageModelV4({
            doStream: async () => call('publish', {}),
          }),
        }),
      ],
    });
    await using h = await harness(root);
    const conversation = { chatId: 'lost-child-continuation', userId: 'u1' };
    const children = async () =>
      (await h.runtime.listHistory(conversation.userId)).find(
        (item) => item.chatId === conversation.chatId,
      )?.children ?? [];
    await (async () => {
      await using _worker = await h.runtime.work();
      void _worker;
      await collectText(
        (await h.runtime.enqueue(conversation, turn('delegate'))).stream,
      );
      await waitFor(
        async () =>
          assert.deepStrictEqual(
            (await children()).map((child) => child.state),
            ['waitingOnApproval'],
          ),
        { interval: 20, signal: t.signal },
      );
    })();
    const [child] = await children();
    assert.ok(child);
    const childConversation = {
      chatId: child.chatId,
      userId: conversation.userId,
    };
    await h.boss.updateQueue(h.queue.queue, { retentionSeconds: 1 });
    const continuation = await approve(
      h.runtime,
      childConversation,
      await pausedToolCallId(h.runtime, childConversation),
    );
    await waitFor(
      async () => {
        await h.boss.supervise(h.queue.queue);
        assert.deepStrictEqual(
          await h.boss.findJobs(h.queue.queue, {
            data: { streamId: continuation.id },
          }),
          [],
        );
      },
      { interval: 100, signal: t.signal },
    );

    await using _worker = await h.runtime.work();
    void _worker;
    assert.deepStrictEqual(
      await untilAborted(Array.fromAsync(continuation.stream), t.signal),
      [{ type: 'error', errorText: LOST_TURN_ERROR }],
    );
    const [{ activities }] = await children();
    assert.deepStrictEqual(
      activities.completion && {
        type: activities.completion.type,
        outcome: activities.completion.outcome,
        streamId: activities.completion.streamId,
        actorPath: activities.completion.actorPath,
      },
      {
        type: 'completion',
        outcome: 'failed',
        streamId: continuation.id,
        actorPath: '/root/research',
      },
      'the sweep that failed the lost turn recorded its completion',
    );
    const completion = [
      'Message Type: FINAL_ANSWER',
      'Task name: /root',
      'Sender: /root/research',
      'Payload:',
      `Agent failed: ${LOST_TURN_ERROR}`,
    ].join('\n');
    for (const ask of ['how is research', 'and now']) {
      await collectText(
        (await h.runtime.enqueue(conversation, turn(ask))).stream,
      );
    }
    assert.deepStrictEqual(
      rootPrompts
        .slice(2)
        .map((prompt) =>
          prompt.flatMap((message) =>
            message.role === 'user'
              ? message.content.flatMap((part) =>
                  part.type === 'text' ? [part.text] : [],
                )
              : [],
          ),
        ),
      [
        ['delegate', completion, 'how is research'],
        ['delegate', completion, 'how is research', 'and now'],
      ],
      'the parent gets the completion once, at its next turn',
    );
  });
});

/**
 * A conversation whose approved idempotent `sendEmail` continuation crashes
 * when it resumes its sandbox, as a dying worker's turn would, so orphan
 * cleanup pushes a recovery turn for it. Asks other than "send it" answer
 * `reply:<ask>`; "hold" first waits for `releaseHold`.
 */
function recoverySetup(conversation: { chatId: string; userId: string }) {
  const track: { calls: string[]; toolRuns: number; explode: boolean } = {
    calls: [],
    toolRuns: 0,
    explode: false,
  };
  const releaseHold = Promise.withResolvers<void>();
  const virtual = buildSandbox();
  const agent = defineAgent({
    name: 'test-agent',
    instructions: [],
    toolApproval: { sendEmail: 'user-approval' },
    tools: {
      sendEmail: defineTool({
        description: 'Send an email',
        inputSchema: z.object({ to: z.string() }),
        recovery: 'idempotent',
        execute: async ({ to }) => {
          track.toolRuns++;
          return `sent:${to}`;
        },
      }),
    },
    sandbox: {
      environment: virtual.environment,
      open: async (chat) => {
        const handle = await virtual.open(chat);
        const resume = handle.sandbox.resume.bind(handle.sandbox);
        handle.sandbox.resume = async () => {
          if (track.explode && chat.chatId === conversation.chatId) {
            track.explode = false;
            throw new Error('continuation sandbox exploded');
          }
          return resume();
        };
        return handle;
      },
    },
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const text = lastUserText(prompt);
        track.calls.push(text);
        if (text === 'hold') await releaseHold.promise;
        const chunks: LanguageModelV4StreamPart[] =
          text === 'send it'
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'tc-send',
                  toolName: 'sendEmail',
                  input: JSON.stringify({ to: 'a@b.c' }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: '' },
                  usage,
                },
              ]
            : [
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: `reply:${text}` },
                { type: 'text-end', id: 't1' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: '' },
                  usage,
                },
              ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    }),
  });
  return { track, agent, releaseHold };
}

/**
 * Pauses "send it" on its approval, approves it with the continuation armed
 * to crash, and pushes another conversation's "hold" turn after it. A worker
 * of concurrency 1 runs the continuation, then "hold" holds its only slot,
 * so the recovery the crash pushes waits, queued, until "hold" is released.
 */
async function pushRecoveryBehindHold(
  h: Awaited<ReturnType<typeof harness>>,
  setup: ReturnType<typeof recoverySetup>,
  conversation: { chatId: string; userId: string },
) {
  await (async () => {
    await using _worker = await h.runtime.work();
    void _worker;
    await collectText(
      (await h.runtime.enqueue(conversation, turn('send it'))).stream,
    );
  })();
  setup.track.explode = true;
  const continuation = await approve(
    h.runtime,
    conversation,
    await pausedToolCallId(h.runtime, conversation),
  );
  const hold = await h.runtime.enqueue(
    { chatId: `${conversation.chatId}-hold`, userId: conversation.userId },
    turn('hold'),
  );
  const jobs = async () =>
    (
      await h.boss.findJobs<TurnRef>(h.queue.queue, {
        data: { streamId: continuation.id },
      })
    ).map((job) => [job.data.kind, job.state]);
  return { continuation, hold, jobs };
}

async function headTool(
  runtime: AgentHost,
  conversation: { chatId: string; userId: string },
) {
  const head = (await runtime.observe(conversation).engine.getMessages()).at(
    -1,
  );
  const part = head?.parts.find(isToolUIPart);
  return (
    part && {
      state: part.state,
      errorText: 'errorText' in part ? part.errorText : undefined,
    }
  );
}

describe('zukhruf runtime — a recovery turn that never runs', () => {
  it("fails a lost recovery's stream, settles the approval it carried, and lets the conversation's next turn run", async (t) => {
    const conversation = { chatId: 'lost-recovery', userId: 'u1' };
    const setup = recoverySetup(conversation);
    await using h = await harness(setup.agent);
    // Platform setup: a tiny retention, and dead-lettered jobs deleted before
    // it, as the 7-day dead-letter default goes before the 14-day retention.
    await h.boss.updateQueue(h.queue.queue, { retentionSeconds: 2 });
    await h.boss.updateQueue(h.queue.deadLetterQueue, {
      deleteAfterSeconds: 1,
    });
    const { continuation, hold, jobs } = await pushRecoveryBehindHold(
      h,
      setup,
      conversation,
    );
    await (async () => {
      await using _worker = await h.runtime.work({ concurrency: 1 });
      void _worker;
      await waitFor(
        async () =>
          assert.deepStrictEqual(await jobs(), [['recovery', 'created']]),
        { interval: 20, signal: t.signal },
      );
      await waitFor(
        async () => {
          await h.boss.supervise(h.queue.queue);
          await h.boss.supervise(h.queue.deadLetterQueue);
          assert.deepStrictEqual(await jobs(), []);
          assert.deepStrictEqual(
            await h.boss.findJobs(h.queue.deadLetterQueue, {
              data: { streamId: continuation.id },
            }),
            [],
          );
        },
        { interval: 100, signal: t.signal },
      );
      setup.releaseHold.resolve();
      assert.equal(
        await untilAborted(collectText(hold.stream), t.signal),
        'reply:hold',
      );
    })();

    await using _worker = await h.runtime.work();
    void _worker;
    const stream = await h.streamStore.getStream(continuation.id);
    assert.deepStrictEqual(
      {
        stream: stream && { status: stream.status, error: stream.error },
        tool: await headTool(h.runtime, conversation),
      },
      {
        stream: { status: 'failed', error: LOST_TURN_ERROR },
        tool: { state: 'output-error', errorText: LOST_TURN_ERROR },
      },
      'the sweep failed the lost recovery and settled the approval it carried',
    );
    assert.equal(
      await untilAborted(
        collectText(
          (await h.runtime.enqueue(conversation, turn('two'))).stream,
        ),
        t.signal,
      ),
      'reply:two',
    );
    assert.deepStrictEqual(setup.track.calls, ['send it', 'hold', 'two']);
    assert.equal(setup.track.toolRuns, 0);
  });

  it("cancelling a queued recovery settles the approval it carried and lets the conversation's next turn run", async (t) => {
    const conversation = { chatId: 'cancelled-recovery', userId: 'u1' };
    const setup = recoverySetup(conversation);
    await using h = await harness(setup.agent);
    const { continuation, hold, jobs } = await pushRecoveryBehindHold(
      h,
      setup,
      conversation,
    );
    await using _worker = await h.runtime.work({ concurrency: 1 });
    void _worker;
    await waitFor(
      async () =>
        assert.deepStrictEqual(await jobs(), [['recovery', 'created']]),
      { interval: 20, signal: t.signal },
    );

    await h.runtime.observe(conversation).cancel();
    setup.releaseHold.resolve();
    assert.equal(
      await untilAborted(collectText(hold.stream), t.signal),
      'reply:hold',
    );

    assert.deepStrictEqual(
      {
        jobs: await jobs(),
        stream: await h.streamStore.getStreamStatus(continuation.id),
        tool: await headTool(h.runtime, conversation),
      },
      {
        jobs: [],
        stream: 'cancelled',
        tool: {
          state: 'output-error',
          errorText: 'approval continuation cancelled',
        },
      },
      'the cancel withdrew the recovery and settled the approval it carried',
    );
    assert.equal(
      await untilAborted(
        collectText(
          (await h.runtime.enqueue(conversation, turn('two'))).stream,
        ),
        t.signal,
      ),
      'reply:two',
    );
    assert.deepStrictEqual(setup.track.calls, ['send it', 'hold', 'two']);
    assert.equal(setup.track.toolRuns, 0);
  });
});
