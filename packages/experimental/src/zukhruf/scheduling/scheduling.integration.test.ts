import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { isToolUIPart, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext, mock } from 'node:test';
import { z } from 'zod';

import {
  type AgentSandbox,
  type ChatUpdater,
  type ContextStore,
  InMemoryContextStore,
  PollingChangeSource,
  PostgresContextStore,
  SqliteContextStore,
  SqliteStreamStore,
  type StoredChatData,
  StreamManager,
} from '@deepagents/context';
import {
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  type SchedulingWake,
  SqliteMailboxStore,
  TurnQueue,
  type TurnRef,
  type Wake,
  WakeScheduler,
  defineAgent,
  defineTool,
} from '@deepagents/experimental/zukhruf';
import { isDockerAvailable, withPostgresContainer } from '@deepagents/test';

const dockerAvailable = await isDockerAvailable();

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

class ControlledTurnQueue extends TurnQueue {
  readonly turns: TurnRef[] = [];
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
  #running?: TurnRef;
  #options?: ConsumeOptions;

  override async push(turn: TurnRef) {
    this.turns.push(turn);
    return { jobId: turn.streamId, inserted: true };
  }

  override async getTurnActivity(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<'idle' | 'queued' | 'running'> {
    const belongsToConversation = (turn: TurnRef) =>
      turn.chatId === conversation.chatId &&
      turn.userId === conversation.userId;
    if (this.#running && belongsToConversation(this.#running)) return 'running';
    return this.turns.some(belongsToConversation) ? 'queued' : 'idle';
  }

  override async getCurrentTurn(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ) {
    const belongsToConversation = (turn: TurnRef) =>
      turn.chatId === conversation.chatId &&
      turn.userId === conversation.userId;
    return this.#running && belongsToConversation(this.#running)
      ? this.#running
      : this.turns.find(belongsToConversation);
  }

  override async cancel(streamId: string): Promise<void> {
    const remaining = this.turns.filter((turn) => turn.streamId !== streamId);
    this.turns.splice(0, this.turns.length, ...remaining);
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

  async runNext(): Promise<void> {
    const turn = this.turns.shift();
    assert.ok(turn);
    assert.ok(this.#handler);
    this.#running = turn;
    try {
      await this.#handler(turn, {
        signal: new AbortController().signal,
        park: async () => assert.fail('turn unexpectedly parked'),
      });
    } finally {
      this.#running = undefined;
    }
    await this.#options?.onSettled?.(turn);
  }
}

class RecordingWakeScheduler extends WakeScheduler<SchedulingWake> {
  readonly wakes = new Map<string, Wake<SchedulingWake>>();
  readonly handlers = new Set<(wake: Wake<SchedulingWake>) => Promise<void>>();
  failNextSchedule = false;

  get handler(): ((wake: Wake<SchedulingWake>) => Promise<void>) | undefined {
    return this.handlers.values().next().value;
  }

  override async schedule(wake: Wake<SchedulingWake>): Promise<void> {
    if (this.failNextSchedule) {
      this.failNextSchedule = false;
      throw new Error('simulated wake insertion outage');
    }
    this.wakes.set(wake.id, wake);
  }

  override async cancel(id: string): Promise<void> {
    this.wakes.delete(id);
  }

  override async consume(
    handler: (wake: Wake<SchedulingWake>) => Promise<void>,
  ): Promise<AsyncDisposable> {
    this.handlers.add(handler);
    return {
      [Symbol.asyncDispose]: async () => {
        this.handlers.delete(handler);
      },
    };
  }

  async fire(id: string): Promise<void> {
    const wake = this.wakes.get(id);
    const handler = this.handler;
    assert.ok(wake, `expected wake ${id}`);
    assert.ok(handler, 'expected a running wake consumer');
    await handler(wake);
    this.wakes.delete(id);
  }

  async deliverAcrossConsumers(id: string): Promise<void> {
    const wake = this.wakes.get(id);
    assert.ok(wake, `expected wake ${id}`);
    assert.ok(this.handlers.size >= 2, 'expected independent wake consumers');
    await Promise.all([...this.handlers].map((handler) => handler(wake)));
    this.wakes.delete(id);
  }
}

class FailOnceSchedulingAdvanceStore extends InMemoryContextStore {
  failNextSchedulingAdvance = false;

  override updateChat(
    chatId: string,
    update: ChatUpdater,
  ): Promise<StoredChatData> {
    return super.updateChat(chatId, (chat) => {
      const result = update(chat);
      if (
        this.failNextSchedulingAdvance &&
        dynamicState(chat.metadata) !== undefined &&
        dynamicState(result?.metadata) === undefined
      ) {
        this.failNextSchedulingAdvance = false;
        throw new Error('simulated scheduling advance outage');
      }
      return result;
    });
  }
}

function dynamicState(metadata: Record<string, unknown> | undefined): unknown {
  const zukhruf = metadata?.zukhruf;
  if (typeof zukhruf !== 'object' || zukhruf === null) return;
  const scheduling = (zukhruf as { scheduling?: unknown }).scheduling;
  if (typeof scheduling !== 'object' || scheduling === null) return;
  return (scheduling as { dynamic?: unknown }).dynamic;
}

function functionToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(
      (tool): tool is LanguageModelV4FunctionTool =>
        typeof tool === 'object' &&
        tool !== null &&
        'type' in tool &&
        tool.type === 'function',
    )
    .map(({ name }) => name)
    .toSorted();
}

function harness(
  t: TestContext,
  scheduler: RecordingWakeScheduler,
  store: ContextStore = new InMemoryContextStore(),
) {
  const streamStore = new SqliteStreamStore(':memory:');
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const streams = new StreamManager({
    store: streamStore,
    changeSource: new PollingChangeSource({ reads: streamStore }),
  });
  const queue = new ControlledTurnQueue();
  t.after(() => {
    streamStore.close();
    mailboxStore.close();
  });
  return { store, streams, mailboxStore, queue };
}

function lastUserText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return '';
  const message = prompt
    .filter(
      (
        candidate,
      ): candidate is {
        role: 'user';
        content: Array<{ type: string; text?: string }>;
      } =>
        typeof candidate === 'object' &&
        candidate !== null &&
        'role' in candidate &&
        candidate.role === 'user' &&
        'content' in candidate &&
        Array.isArray(candidate.content),
    )
    .at(-1);
  return (
    message?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('') ?? ''
  );
}

function toolModel(
  commands: Map<string, { name: string; input: unknown }>,
  seenUserText: string[],
) {
  const calls = new Map<string, number>();
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      seenUserText.push(text);
      const count = (calls.get(text) ?? 0) + 1;
      calls.set(text, count);
      const command = commands.get(text);
      const chunks: LanguageModelV4StreamPart[] =
        command && count === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: `call-${command.name}-${text}`,
                toolName: command.name,
                input: JSON.stringify(command.input),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: '' },
                usage,
              },
            ]
          : [
              { type: 'text-start', id: 'text-1' },
              {
                type: 'text-delta',
                id: 'text-1',
                delta: `done:${text}`,
              },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ];
      return {
        stream: simulateReadableStream({ chunks }),
      };
    },
  });
}

async function runTurn(
  runtime: AgentRuntime,
  queue: ControlledTurnQueue,
  conversation: { chatId: string; userId: string },
  input: string,
) {
  await runtime.enqueue(conversation, {
    id: `turn:${input}:${crypto.randomUUID()}`,
    input,
  });
  await queue.runNext();
}

test('configured runtime injects Claude-compatible scheduling tools', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  let toolNames: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      toolNames = functionToolNames(tools);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 'text-1' },
            { type: 'text-delta' as const, id: 'text-1', delta: 'done' },
            { type: 'text-end' as const, id: 'text-1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: '' },
              usage,
            },
          ],
        }),
      };
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
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );

  await runtime.enqueue(
    { chatId: 'scheduled-tools', userId: 'user-1' },
    { id: 'turn-1', input: 'show tools' },
  );
  await using _worker = await runtime.work();
  await h.queue.runNext();

  assert.deepEqual(
    toolNames.filter((name) =>
      ['CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup'].includes(name),
    ),
    ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'],
  );
});

test('CronCreate, CronList, and CronDelete run through the model loop in one conversation', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create cron',
      {
        name: 'CronCreate',
        input: { cron: '*/15 * * * *', prompt: 'review progress' },
      },
    ],
    ['list cron', { name: 'CronList', input: {} }],
  ]);
  const seenUserText: string[] = [];
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, seenUserText),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'Asia/Amman' },
    },
  );
  const conversation = { chatId: 'cron-tools', userId: 'user-1' };
  await using _worker = await runtime.work();

  await runTurn(runtime, h.queue, conversation, 'create cron');
  assert.equal(scheduler.wakes.size, 1);
  const definitionId = [...scheduler.wakes.values()][0].data.definitionId;
  assert.match(definitionId ?? '', /^[0-9a-f]{8}$/);

  await runTurn(runtime, h.queue, conversation, 'list cron');
  const listTool = (await runtime.observe(conversation).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.deepEqual(listTool?.output, {
    jobs: [
      {
        id: definitionId,
        cron: '*/15 * * * *',
        humanSchedule: 'Every 15 minutes',
        prompt: 'review progress',
      },
    ],
  });

  commands.set('delete cron', {
    name: 'CronDelete',
    input: { id: definitionId },
  });
  await runTurn(runtime, h.queue, conversation, 'delete cron');
  assert.equal(scheduler.wakes.size, 0);

  commands.set('list empty', { name: 'CronList', input: {} });
  await runTurn(runtime, h.queue, conversation, 'list empty');
  const emptyList = (await runtime.observe(conversation).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.deepEqual(emptyList?.output, { jobs: [] });
});

test('parallel model tool calls preserve concurrent cron creates and deletes', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const calls = new Map<string, number>();
  let definitionIds: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      const count = (calls.get(text) ?? 0) + 1;
      calls.set(text, count);
      let toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      if (count === 1 && text === 'create two') {
        toolCalls = [
          {
            id: 'create-a',
            name: 'CronCreate',
            input: { cron: '*/10 * * * *', prompt: 'first' },
          },
          {
            id: 'create-b',
            name: 'CronCreate',
            input: { cron: '*/20 * * * *', prompt: 'second' },
          },
        ];
      } else if (count === 1 && text === 'delete two') {
        toolCalls = definitionIds.map((id) => ({
          id: `delete-${id}`,
          name: 'CronDelete',
          input: { id },
        }));
      }
      return {
        stream: simulateReadableStream({
          chunks:
            toolCalls.length > 0
              ? [
                  ...toolCalls.map(
                    ({ id, name, input }): LanguageModelV4StreamPart => ({
                      type: 'tool-call',
                      toolCallId: id,
                      toolName: name,
                      input: JSON.stringify(input),
                    }),
                  ),
                  {
                    type: 'finish' as const,
                    finishReason: { unified: 'tool-calls' as const, raw: '' },
                    usage,
                  },
                ]
              : [
                  { type: 'text-start' as const, id: 'text-1' },
                  { type: 'text-delta' as const, id: 'text-1', delta: 'done' },
                  { type: 'text-end' as const, id: 'text-1' },
                  {
                    type: 'finish' as const,
                    finishReason: { unified: 'stop' as const, raw: '' },
                    usage,
                  },
                ],
        }),
      };
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
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'parallel-cron', userId: 'user-1' };
  await using _worker = await runtime.work();

  await runTurn(runtime, h.queue, conversation, 'create two');
  definitionIds = [...scheduler.wakes.values()]
    .map(({ data }) => data.definitionId)
    .filter((id): id is string => id !== undefined);
  assert.equal(new Set(definitionIds).size, 2);

  await runTurn(runtime, h.queue, conversation, 'delete two');
  assert.equal(scheduler.wakes.size, 0);
});

test('ScheduleWakeup clamps, fires an ask, and persists scheduled provenance', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'schedule dynamic',
      {
        name: 'ScheduleWakeup',
        input: {
          delaySeconds: 12.6,
          reason: 'check after enough time',
          prompt: 'scheduled prompt',
        },
      },
    ],
  ]);
  const seenUserText: string[] = [];
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, seenUserText),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'dynamic-tools', userId: 'user-1' };
  await using _worker = await runtime.work();

  await runTurn(runtime, h.queue, conversation, 'schedule dynamic');
  const scheduleTool = (
    await runtime.observe(conversation).engine.getMessages()
  )
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.deepEqual(
    {
      clampedDelaySeconds: (
        scheduleTool?.output as { clampedDelaySeconds?: number }
      )?.clampedDelaySeconds,
      wasClamped: (scheduleTool?.output as { wasClamped?: boolean })
        ?.wasClamped,
    },
    { clampedDelaySeconds: 60, wasClamped: true },
  );

  const wake = [...scheduler.wakes.values()][0];
  await scheduler.fire(wake.id);
  assert.equal(h.queue.turns.length, 1);
  const scheduledTurn = h.queue.turns[0];
  assert.equal(scheduledTurn.kind, 'ask');
  if (scheduledTurn.kind !== 'ask') assert.fail('expected scheduled ask');
  assert.equal(scheduledTurn.origin, 'scheduled');
  assert.equal(scheduledTurn.input, 'scheduled prompt');

  await h.queue.runNext();
  assert.equal(seenUserText.at(-1), 'scheduled prompt');
  assert.ok(!seenUserText.at(-1)!.includes('check after enough time'));
  const messages = await runtime.observe(conversation).engine.getMessages();
  const scheduledUser = messages.find(
    (message) =>
      message.role === 'user' &&
      message.parts.some(
        (part) => part.type === 'text' && part.text === 'scheduled prompt',
      ),
  );
  assert.deepEqual(
    (scheduledUser?.metadata as { zukhruf?: { origin?: string } })?.zukhruf
      ?.origin,
    'scheduled',
  );
});

test('a busy cron window materializes one catch-up ask after queued user work', async (t) => {
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(new Date('2026-08-12T10:00:00Z').getTime());
  t.after(() => mock.timers.reset());

  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const firstStarted = Promise.withResolvers<void>();
  const finishFirst = Promise.withResolvers<void>();
  const seenUserText: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      seenUserText.push(text);
      if (text === 'long user turn') {
        firstStarted.resolve();
        await finishFirst.promise;
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 'text-1' },
            {
              type: 'text-delta' as const,
              id: 'text-1',
              delta: `done:${text}`,
            },
            { type: 'text-end' as const, id: 'text-1' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: '' },
              usage,
            },
          ],
        }),
      };
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
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'busy-cron', userId: 'user-1' };
  await runtime.createSession(conversation);
  await h.store.updateChat(conversation.chatId, ({ metadata }) => ({
    metadata: {
      ...metadata,
      zukhruf: {
        ...(metadata!.zukhruf as Record<string, unknown>),
        scheduling: {
          version: 1,
          cron: {
            deadbeef: {
              id: 'deadbeef',
              expression: '*/10 * * * *',
              prompt: 'scheduled catch-up',
              recurring: true,
              timezone: 'UTC',
              createdAt: Date.now(),
              expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
              nextRunAt: Date.now() + 10 * 60_000,
              generation: 1,
            },
          },
        },
      },
    },
  }));
  await using _worker = await runtime.work();

  await runtime.enqueue(conversation, {
    id: 'long-user-turn',
    input: 'long user turn',
  });
  const running = h.queue.runNext();
  await firstStarted.promise;
  await runtime.enqueue(conversation, {
    id: 'queued-user-turn',
    input: 'queued user turn',
  });

  for (let occurrence = 1; occurrence <= 3; occurrence++) {
    mock.timers.tick(10 * 60_000);
    const due = [...scheduler.wakes.values()].find(
      ({ runAt }) => runAt.getTime() <= Date.now(),
    );
    if (due) await scheduler.fire(due.id);
    assert.deepEqual(
      h.queue.turns.map((turn) =>
        turn.kind === 'ask' ? turn.input : turn.kind,
      ),
      ['queued user turn'],
      `tick ${occurrence} does not materialize scheduled work while busy`,
    );
  }

  mock.timers.tick(5 * 60_000);
  finishFirst.resolve();
  await running;
  assert.deepEqual(
    h.queue.turns.map((turn) => (turn.kind === 'ask' ? turn.input : turn.kind)),
    ['queued user turn'],
  );

  await h.queue.runNext();
  assert.deepEqual(
    h.queue.turns.map((turn) => (turn.kind === 'ask' ? turn.input : turn.kind)),
    ['scheduled catch-up'],
  );
  await runtime.enqueue(conversation, {
    id: 'later-user-turn',
    input: 'later user turn',
  });
  await h.queue.runNext();
  await h.queue.runNext();
  assert.deepEqual(seenUserText, [
    'long user turn',
    'queued user turn',
    'scheduled catch-up',
    'later user turn',
  ]);
  assert.equal(
    [...scheduler.wakes.values()].filter(
      ({ data }) => data.definitionId === 'deadbeef',
    ).length,
    1,
  );
});

test('unconfigured runtime exposes no scheduling tools', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  let toolNames: string[] = [];
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async ({ tools }) => {
          toolNames = functionToolNames(tools);
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'text-start' as const, id: 'text-1' },
                { type: 'text-delta' as const, id: 'text-1', delta: 'done' },
                { type: 'text-end' as const, id: 'text-1' },
                {
                  type: 'finish' as const,
                  finishReason: { unified: 'stop' as const, raw: '' },
                  usage,
                },
              ],
            }),
          };
        },
      }),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    h,
  );
  await runtime.enqueue(
    { chatId: 'no-scheduling', userId: 'user-1' },
    { id: 'turn-1', input: 'show tools' },
  );
  await using _worker = await runtime.work();
  await h.queue.runNext();
  assert.deepEqual(
    toolNames.filter((name) =>
      ['CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup'].includes(name),
    ),
    [],
  );
  assert.equal(scheduler.handler, undefined);
});

test('runtime rejects an invalid scheduling timezone during construction', (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  assert.throws(
    () =>
      new AgentRuntime(
        defineAgent({
          name: 'root',
          model: new MockLanguageModelV4({}),
          sandbox: async () => ({}) as AgentSandbox,
          instructions: [],
        }),
        {
          ...h,
          scheduling: { scheduler, timezone: 'Not/A_Timezone' },
        },
      ),
    /Invalid scheduling timezone/,
  );
});

test('startup reconciliation repairs a definition persisted before wake insertion', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create during outage',
      {
        name: 'CronCreate',
        input: { cron: '*/10 * * * *', prompt: 'durable prompt' },
      },
    ],
  ]);
  const model = toolModel(commands, []);
  const declaration = defineAgent({
    name: 'root',
    model,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(declaration, {
    ...h,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  const conversation = { chatId: 'create-gap', userId: 'user-1' };
  const firstWorker = await runtime.work();
  scheduler.failNextSchedule = true;
  await runTurn(runtime, h.queue, conversation, 'create during outage');
  assert.equal(scheduler.wakes.size, 0);
  await firstWorker[Symbol.asyncDispose]();

  const restarted = new AgentRuntime(declaration, {
    ...h,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  await using _restartedWorker = await restarted.work();
  assert.equal(scheduler.wakes.size, 1);
  assert.equal(
    [...scheduler.wakes.values()][0].data.conversation.chatId,
    'create-gap',
  );
});

test('retrying a completed CronCreate tool call reuses its definition and wake', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'retry create response',
      {
        name: 'CronCreate',
        input: { cron: '*/10 * * * *', prompt: 'idempotent definition' },
      },
    ],
  ]);
  const root = (model: ReturnType<typeof toolModel>) =>
    defineAgent({
      name: 'root',
      model,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    });
  const conversation = { chatId: 'create-response-gap', userId: 'user-1' };
  const firstRuntime = new AgentRuntime(root(toolModel(commands, [])), {
    ...h,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  const firstWorker = await firstRuntime.work();
  await runTurn(firstRuntime, h.queue, conversation, 'retry create response');
  const firstWake = [...scheduler.wakes.values()][0];
  await firstWorker[Symbol.asyncDispose]();

  const retriedRuntime = new AgentRuntime(root(toolModel(commands, [])), {
    ...h,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  await using _retriedWorker = await retriedRuntime.work();
  await runTurn(retriedRuntime, h.queue, conversation, 'retry create response');
  assert.deepEqual([...scheduler.wakes.values()], [firstWake]);
  const chat = await h.store.getChat(conversation.chatId);
  const scheduling = (
    chat!.metadata!.zukhruf as {
      scheduling: { cron: Record<string, unknown> };
    }
  ).scheduling;
  assert.equal(Object.keys(scheduling.cron).length, 1);
});

test('retry after enqueue-before-advance executes one scheduled turn', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const store = new FailOnceSchedulingAdvanceStore();
  const h = harness(t, scheduler, store);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'schedule crash window',
      {
        name: 'ScheduleWakeup',
        input: {
          delaySeconds: 60,
          reason: 'exercise crash window',
          prompt: 'deduplicated scheduled prompt',
        },
      },
    ],
  ]);
  const seenUserText: string[] = [];
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, seenUserText),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'advance-gap', userId: 'user-1' };
  await using _worker = await runtime.work();
  await runTurn(runtime, h.queue, conversation, 'schedule crash window');
  const wake = [...scheduler.wakes.values()][0];

  store.failNextSchedulingAdvance = true;
  await assert.rejects(scheduler.fire(wake.id), /scheduling advance outage/);
  assert.equal(h.queue.turns.length, 1);
  await scheduler.fire(wake.id);
  assert.equal(
    h.queue.turns.length,
    1,
    'the queued occurrence makes the retry ineligible to materialize again',
  );

  await h.queue.runNext();
  assert.equal(
    seenUserText.filter((text) => text === 'deduplicated scheduled prompt')
      .length,
    1,
  );
  const messages = await runtime.observe(conversation).engine.getMessages();
  assert.equal(
    messages.filter(
      (message) =>
        message.role === 'user' &&
        message.parts.some(
          (part) =>
            part.type === 'text' &&
            part.text === 'deduplicated scheduled prompt',
        ),
    ).length,
    1,
  );
});

test('reconciliation repairs a successor lost after recurrence advances', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create recurring crash window',
      {
        name: 'CronCreate',
        input: { cron: '* * * * *', prompt: 'successor prompt' },
      },
    ],
  ]);
  const seenUserText: string[] = [];
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, seenUserText),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'successor-gap', userId: 'user-1' };
  await using _worker = await runtime.work();
  await runTurn(
    runtime,
    h.queue,
    conversation,
    'create recurring crash window',
  );
  const first = [...scheduler.wakes.values()][0];

  scheduler.failNextSchedule = true;
  await assert.rejects(scheduler.fire(first.id), /wake insertion outage/);
  assert.equal(h.queue.turns.length, 1);
  const successor = [...scheduler.wakes.values()].find(
    ({ id }) => id !== first.id,
  );
  assert.ok(successor, 'reconciliation should arm the persisted successor');

  await scheduler.fire(first.id);
  assert.equal(
    h.queue.turns.length,
    1,
    'the stale receipt must not enqueue again',
  );
  await h.queue.runNext();
  assert.equal(
    seenUserText.filter((text) => text === 'successor prompt').length,
    1,
  );
});

test('ScheduleWakeup replacement and stop leave cron definitions active', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create fixed',
      {
        name: 'CronCreate',
        input: { cron: '0 * * * *', prompt: 'fixed prompt' },
      },
    ],
    [
      'schedule first',
      {
        name: 'ScheduleWakeup',
        input: { delaySeconds: 61, reason: 'first', prompt: 'first prompt' },
      },
    ],
    [
      'schedule replacement',
      {
        name: 'ScheduleWakeup',
        input: {
          delaySeconds: 3_601,
          reason: 'replacement',
          prompt: 'replacement prompt',
        },
      },
    ],
    ['stop dynamic', { name: 'ScheduleWakeup', input: { stop: true } }],
  ]);
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, []),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'replace-stop', userId: 'user-1' };
  await using _worker = await runtime.work();

  await runTurn(runtime, h.queue, conversation, 'create fixed');
  const cronWakeId = [...scheduler.wakes.values()].find(
    ({ data }) => data.kind === 'cron',
  )!.id;
  await runTurn(runtime, h.queue, conversation, 'schedule first');
  const firstDynamic = [...scheduler.wakes.values()].find(
    ({ data }) => data.kind === 'dynamic',
  )!;
  await runTurn(runtime, h.queue, conversation, 'schedule replacement');
  const replacement = [...scheduler.wakes.values()].find(
    ({ data }) => data.kind === 'dynamic',
  )!;
  assert.notEqual(replacement.id, firstDynamic.id);
  assert.equal(replacement.runAt.getTime() - replacement.data.scheduledFor, 0);
  assert.equal(scheduler.wakes.has(firstDynamic.id), false);
  await scheduler.handler!(firstDynamic);
  assert.equal(h.queue.turns.length, 0, 'a replaced receipt must be stale');

  await runTurn(runtime, h.queue, conversation, 'stop dynamic');
  assert.deepEqual([...scheduler.wakes.keys()], [cronWakeId]);
  await scheduler.handler!(replacement);
  assert.equal(h.queue.turns.length, 0, 'a stopped receipt must be stale');
});

test('a queued scheduled turn can be cancelled through AgentObservation', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'schedule cancellable',
      {
        name: 'ScheduleWakeup',
        input: {
          delaySeconds: 60,
          reason: 'cancel before execution',
          prompt: 'must not execute',
        },
      },
    ],
  ]);
  const seenUserText: string[] = [];
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, seenUserText),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'scheduled-cancel', userId: 'user-1' };
  await using _worker = await runtime.work();
  await runTurn(runtime, h.queue, conversation, 'schedule cancellable');
  await scheduler.fire([...scheduler.wakes.keys()][0]);
  const scheduled = h.queue.turns[0];
  assert.ok(scheduled);

  await runtime.observe(conversation).cancel(scheduled.streamId);
  assert.equal(h.queue.turns.length, 0);
  assert.ok(!seenUserText.includes('must not execute'));
});

test('cancelling the last queued user turn materializes one overdue occurrence', async (t) => {
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(new Date('2026-08-12T10:00:00Z').getTime());
  t.after(() => mock.timers.reset());

  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(new Map(), []),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'cancel-user-for-cron', userId: 'user-1' };
  await runtime.createSession(conversation);
  await h.store.updateChat(conversation.chatId, ({ metadata }) => ({
    metadata: {
      ...metadata,
      zukhruf: {
        ...(metadata!.zukhruf as Record<string, unknown>),
        scheduling: {
          version: 1,
          cron: {
            deadbeef: {
              id: 'deadbeef',
              expression: '*/10 * * * *',
              prompt: 'cancel catch-up',
              recurring: true,
              timezone: 'UTC',
              createdAt: Date.now(),
              expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
              nextRunAt: Date.now() + 10 * 60_000,
              generation: 1,
            },
          },
        },
      },
    },
  }));
  await using _worker = await runtime.work();
  const queued = await runtime.enqueue(conversation, {
    id: 'cancel-user-turn',
    input: 'cancel me',
  });
  mock.timers.tick(10 * 60_000);
  await scheduler.fire([...scheduler.wakes.keys()][0]);
  assert.equal(h.queue.turns.length, 1);

  await runtime.observe(conversation).cancel(queued.id);
  assert.equal(h.queue.turns.length, 1);
  const catchUp = h.queue.turns[0];
  assert.ok(catchUp?.kind === 'ask');
  assert.equal(catchUp.origin, 'scheduled');
  assert.equal(catchUp.input, 'cancel catch-up');
});

test('an overdue occurrence waits for approval before materializing', async (t) => {
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(new Date('2026-08-12T10:00:00Z').getTime());
  t.after(() => mock.timers.reset());

  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  let calls = 0;
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => {
          calls++;
          const chunks: LanguageModelV4StreamPart[] =
            calls === 1
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: 'approval-call',
                    toolName: 'publish',
                    input: '{}',
                  },
                  {
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: '' },
                    usage,
                  },
                ]
              : [
                  { type: 'text-start', id: 'text-1' },
                  {
                    type: 'text-delta',
                    id: 'text-1',
                    delta: 'done',
                  },
                  { type: 'text-end', id: 'text-1' },
                  {
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: '' },
                    usage,
                  },
                ];
          return {
            stream: simulateReadableStream({ chunks }),
          };
        },
      }),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      tools: {
        publish: defineTool({
          description: 'Publish the result',
          inputSchema: z.object({}),
          needsApproval: true,
          execute: async () => 'published',
        }),
      },
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'approval-cron', userId: 'user-1' };
  await runtime.createSession(conversation);
  await h.store.updateChat(conversation.chatId, ({ metadata }) => ({
    metadata: {
      ...metadata,
      zukhruf: {
        ...(metadata!.zukhruf as Record<string, unknown>),
        scheduling: {
          version: 1,
          cron: {
            deadbeef: {
              id: 'deadbeef',
              expression: '*/10 * * * *',
              prompt: 'approval catch-up',
              recurring: true,
              timezone: 'UTC',
              createdAt: Date.now(),
              expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
              nextRunAt: Date.now() + 10 * 60_000,
              generation: 1,
            },
          },
        },
      },
    },
  }));
  await using _worker = await runtime.work();
  await runTurn(runtime, h.queue, conversation, 'needs approval');
  mock.timers.tick(10 * 60_000);
  await scheduler.fire([...scheduler.wakes.keys()][0]);
  assert.deepEqual(h.queue.turns, []);

  await runtime.approve(conversation, { toolCallId: 'approval-call' });
  await h.queue.runNext();
  const [catchUp] = h.queue.turns as TurnRef[];
  assert.ok(catchUp?.kind === 'ask');
  assert.equal(catchUp.origin, 'scheduled');
  assert.equal(catchUp.input, 'approval catch-up');
});

test('a non-recurring cron fires once and removes its definition', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create one shot',
      {
        name: 'CronCreate',
        input: {
          cron: '* * * * *',
          prompt: 'one-shot prompt',
          recurring: false,
        },
      },
    ],
  ]);
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, []),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'cron-one-shot', userId: 'user-1' };
  await using _worker = await runtime.work();

  await runTurn(runtime, h.queue, conversation, 'create one shot');
  const wake = [...scheduler.wakes.values()][0];
  await scheduler.fire(wake.id);
  await h.queue.runNext();
  assert.equal(scheduler.wakes.size, 0);

  commands.set('list after one shot', { name: 'CronList', input: {} });
  await runTurn(runtime, h.queue, conversation, 'list after one shot');
  const list = (await runtime.observe(conversation).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.deepEqual(list?.output, { jobs: [] });
});

test('recurrence keeps the timezone persisted at creation across runtime restart', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create zoned cron',
      {
        name: 'CronCreate',
        input: { cron: '0 9 * * *', prompt: 'zoned prompt' },
      },
    ],
  ]);
  const declaration = defineAgent({
    name: 'root',
    model: toolModel(commands, []),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const conversation = { chatId: 'timezone-stability', userId: 'user-1' };
  const firstRuntime = new AgentRuntime(declaration, {
    ...h,
    scheduling: { scheduler, timezone: 'Asia/Amman' },
  });
  const firstWorker = await firstRuntime.work();
  await runTurn(firstRuntime, h.queue, conversation, 'create zoned cron');
  const firstWake = [...scheduler.wakes.values()][0];
  await firstWorker[Symbol.asyncDispose]();

  const restarted = new AgentRuntime(declaration, {
    ...h,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  await using _restartedWorker = await restarted.work();
  await scheduler.fire(firstWake.id);
  const successor = [...scheduler.wakes.values()][0];
  assert.equal(successor.data.kind, 'cron');
  assert.equal(
    successor.runAt.getUTCHours(),
    6,
    '09:00 Asia/Amman remains 06:00 UTC after host timezone changes',
  );
});

test('cron definitions are isolated by conversation and user across runtimes', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create private cron',
      {
        name: 'CronCreate',
        input: { cron: '*/30 * * * *', prompt: 'private prompt' },
      },
    ],
    ['list other conversation', { name: 'CronList', input: {} }],
  ]);
  const declaration = defineAgent({
    name: 'root',
    model: toolModel(commands, []),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(declaration, {
    ...h,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  const worker = await runtime.work();
  await runTurn(
    runtime,
    h.queue,
    { chatId: 'private-a', userId: 'user-a' },
    'create private cron',
  );
  await worker[Symbol.asyncDispose]();

  const otherRuntime = new AgentRuntime(declaration, {
    ...h,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  await using _otherWorker = await otherRuntime.work();
  const other = { chatId: 'private-b', userId: 'user-b' };
  await runTurn(otherRuntime, h.queue, other, 'list other conversation');
  const result = (await otherRuntime.observe(other).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.deepEqual(result?.output, { jobs: [] });
});

test('scheduling tools bind to the current root, child, and sibling conversations', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'spawn owner',
      {
        name: 'spawn_agent',
        input: {
          agent_type: 'worker',
          task_name: 'owner',
          message: 'create child cron',
          fork_turns: 'none',
        },
      },
    ],
    [
      'create child cron',
      {
        name: 'CronCreate',
        input: { cron: '*/15 * * * *', prompt: 'child-owned' },
      },
    ],
    [
      'spawn sibling',
      {
        name: 'spawn_agent',
        input: {
          agent_type: 'worker',
          task_name: 'sibling',
          message: 'list sibling cron',
          fork_turns: 'none',
        },
      },
    ],
    ['list sibling cron', { name: 'CronList', input: {} }],
    ['list root cron', { name: 'CronList', input: {} }],
  ]);
  const model = toolModel(commands, []);
  const sandbox = async () => ({}) as AgentSandbox;
  const worker = defineAgent({
    name: 'worker',
    model,
    sandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model,
      sandbox,
      instructions: [],
      subagents: [worker],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const root = { chatId: 'scheduling-root', userId: 'user-1' };
  await using _worker = await runtime.work();

  await runTurn(runtime, h.queue, root, 'spawn owner');
  const ownerTurn = h.queue.turns[0];
  assert.ok(ownerTurn && ownerTurn.kind === 'ask');
  const owner = { chatId: ownerTurn.chatId, userId: ownerTurn.userId };
  await h.queue.runNext();
  const ownerWake = [...scheduler.wakes.values()][0];
  assert.deepEqual(ownerWake.data.conversation, owner);
  const definitionId = ownerWake.data.definitionId!;

  while (h.queue.turns.length > 0) await h.queue.runNext();
  await runTurn(runtime, h.queue, root, 'spawn sibling');
  const siblingTurn = h.queue.turns[0];
  assert.ok(siblingTurn && siblingTurn.kind === 'ask');
  const sibling = { chatId: siblingTurn.chatId, userId: siblingTurn.userId };
  assert.notEqual(sibling.chatId, owner.chatId);
  await h.queue.runNext();
  const siblingList = (await runtime.observe(sibling).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.deepEqual(siblingList?.output, { jobs: [] });

  commands.set('delete sibling cron', {
    name: 'CronDelete',
    input: { id: definitionId },
  });
  while (h.queue.turns.length > 0) await h.queue.runNext();
  await runTurn(runtime, h.queue, sibling, 'delete sibling cron');
  const siblingDelete = (await runtime.observe(sibling).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.equal(siblingDelete?.state, 'output-error');
  assert.equal(scheduler.wakes.has(ownerWake.id), true);

  while (h.queue.turns.length > 0) await h.queue.runNext();
  await runTurn(runtime, h.queue, root, 'list root cron');
  const rootList = (await runtime.observe(root).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.deepEqual(rootList?.output, { jobs: [] });
});

test('malformed reserved scheduling metadata fails closed on worker startup', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const declaration = defineAgent({
    name: 'root',
    model: new MockLanguageModelV4({}),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const runtime = new AgentRuntime(declaration, {
    ...h,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  const conversation = { chatId: 'malformed-state', userId: 'user-1' };
  await runtime.createSession(conversation);
  await h.store.updateChat(conversation.chatId, ({ metadata }) => ({
    metadata: {
      ...metadata,
      zukhruf: {
        ...(metadata!.zukhruf as Record<string, unknown>),
        scheduling: { version: 99, cron: {} },
      },
    },
  }));
  await assert.rejects(
    runtime.work(),
    /Invalid metadata\.zukhruf\.scheduling state/,
  );
  assert.equal(scheduler.handler, undefined);
});

test('CronCreate rejects six-field and unreachable expressions', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'six fields',
      {
        name: 'CronCreate',
        input: { cron: '0 */5 * * * *', prompt: 'invalid syntax' },
      },
    ],
    [
      'unreachable',
      {
        name: 'CronCreate',
        input: { cron: '0 0 31 2 *', prompt: 'no occurrence' },
      },
    ],
    [
      'missing dynamic reason',
      {
        name: 'ScheduleWakeup',
        input: { delaySeconds: 60, prompt: 'missing reason' },
      },
    ],
  ]);
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, []),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'invalid-cron', userId: 'user-1' };
  await using _worker = await runtime.work();
  await runTurn(runtime, h.queue, conversation, 'six fields');
  await runTurn(runtime, h.queue, conversation, 'unreachable');
  await runTurn(runtime, h.queue, conversation, 'missing dynamic reason');
  assert.equal(scheduler.wakes.size, 0);
  const errors = (await runtime.observe(conversation).engine.getMessages())
    .flatMap(({ parts }) => parts.filter(isToolUIPart))
    .filter(({ state }) => state === 'output-error');
  assert.equal(errors.length, 3);
});

test('CronCreate enforces the 50-definition conversation cap', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create fifty first',
      {
        name: 'CronCreate',
        input: { cron: '*/5 * * * *', prompt: 'over capacity' },
      },
    ],
  ]);
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, []),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'cron-cap', userId: 'user-1' };
  await runtime.createSession(conversation);
  const now = Date.now();
  const cron = Object.fromEntries(
    Array.from({ length: 50 }, (_, index) => {
      const id = index.toString(16).padStart(8, '0');
      return [
        id,
        {
          id,
          expression: '*/5 * * * *',
          prompt: `job ${index}`,
          recurring: true,
          timezone: 'UTC',
          createdAt: now,
          expiresAt: now + 7 * 24 * 60 * 60 * 1_000,
          nextRunAt: now + 60_000,
          generation: 1,
        },
      ];
    }),
  );
  await h.store.updateChat(conversation.chatId, ({ metadata }) => ({
    metadata: {
      ...metadata,
      zukhruf: {
        ...(metadata!.zukhruf as Record<string, unknown>),
        scheduling: { version: 1, cron },
      },
    },
  }));
  await using _worker = await runtime.work();
  assert.equal(scheduler.wakes.size, 50);

  await runTurn(runtime, h.queue, conversation, 'create fifty first');
  assert.equal(scheduler.wakes.size, 50);
  const result = (await runtime.observe(conversation).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.equal(result?.state, 'output-error');
});

test('a dynamic wake survives a file-backed metadata restart', async (t) => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-dynamic-restart-'),
  );
  const databasePath = join(directory.path, 'context.sqlite');
  const firstDatabase = new DatabaseSync(databasePath);
  const firstStore = new SqliteContextStore(firstDatabase);
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler, firstStore);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'schedule persistent dynamic',
      {
        name: 'ScheduleWakeup',
        input: {
          delaySeconds: 60,
          reason: 'survive restart',
          prompt: 'restarted dynamic prompt',
        },
      },
    ],
  ]);
  const seenUserText: string[] = [];
  const declaration = defineAgent({
    name: 'root',
    model: toolModel(commands, seenUserText),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const conversation = { chatId: 'dynamic-file-restart', userId: 'user-1' };
  const firstRuntime = new AgentRuntime(declaration, {
    ...h,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  const firstWorker = await firstRuntime.work();
  await runTurn(
    firstRuntime,
    h.queue,
    conversation,
    'schedule persistent dynamic',
  );
  await firstWorker[Symbol.asyncDispose]();
  scheduler.wakes.clear();
  firstDatabase.close();

  const secondDatabase = new DatabaseSync(databasePath);
  t.after(() => secondDatabase.close());
  const restarted = new AgentRuntime(declaration, {
    ...h,
    store: new SqliteContextStore(secondDatabase),
    scheduling: { scheduler, timezone: 'UTC' },
  });
  await using _restartedWorker = await restarted.work();
  assert.equal(scheduler.wakes.size, 1);
  await scheduler.fire([...scheduler.wakes.keys()][0]);
  await h.queue.runNext();
  assert.equal(seenUserText.at(-1), 'restarted dynamic prompt');
});

test('file-backed restart repairs one overdue cron occurrence and arms the next future match', async (t) => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-scheduling-restart-'),
  );
  const databasePath = join(directory.path, 'context.sqlite');
  const firstDatabase = new DatabaseSync(databasePath);
  const firstStore = new SqliteContextStore(firstDatabase);
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler, firstStore);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create restart cron',
      {
        name: 'CronCreate',
        input: { cron: '* * * * *', prompt: 'catch-up prompt' },
      },
    ],
  ]);
  const seenUserText: string[] = [];
  const declaration = defineAgent({
    name: 'root',
    model: toolModel(commands, seenUserText),
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
  });
  const conversation = { chatId: 'file-restart', userId: 'user-1' };
  const firstRuntime = new AgentRuntime(declaration, {
    ...h,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  const firstWorker = await firstRuntime.work();
  await runTurn(firstRuntime, h.queue, conversation, 'create restart cron');
  const definitionId = [...scheduler.wakes.values()][0].data.definitionId!;
  await firstStore.updateChat(conversation.chatId, ({ metadata }) => {
    const zukhruf = metadata!.zukhruf as Record<string, unknown>;
    const scheduling = zukhruf.scheduling as {
      version: 1;
      cron: Record<string, Record<string, unknown>>;
    };
    return {
      metadata: {
        ...metadata,
        zukhruf: {
          ...zukhruf,
          scheduling: {
            ...scheduling,
            cron: {
              ...scheduling.cron,
              [definitionId]: {
                ...scheduling.cron[definitionId],
                nextRunAt: Date.now() - 5 * 60_000,
              },
            },
          },
        },
      },
    };
  });
  scheduler.wakes.clear();
  await firstWorker[Symbol.asyncDispose]();
  firstDatabase.close();

  const restartedDatabase = new DatabaseSync(databasePath);
  t.after(() => restartedDatabase.close());
  const restartedStore = new SqliteContextStore(restartedDatabase);
  const restarted = new AgentRuntime(declaration, {
    ...h,
    store: restartedStore,
    scheduling: { scheduler, timezone: 'UTC' },
  });
  await using _restartedWorker = await restarted.work();
  assert.equal(scheduler.wakes.size, 1);
  const overdue = [...scheduler.wakes.values()][0];
  assert.ok(overdue.runAt.getTime() < Date.now());

  await scheduler.fire(overdue.id);
  assert.equal(h.queue.turns.length, 1, 'one catch-up turn is enqueued');
  const successor = [...scheduler.wakes.values()][0];
  assert.ok(successor.runAt.getTime() > Date.now());
  await h.queue.runNext();
  assert.equal(
    seenUserText.filter((text) => text === 'catch-up prompt').length,
    1,
  );
});

test('startup removes a recurring definition whose next match is beyond its seven-day expiry', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    ['list expired', { name: 'CronList', input: {} }],
  ]);
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, []),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
  const conversation = { chatId: 'expired-cron', userId: 'user-1' };
  await runtime.createSession(conversation);
  const now = Date.now();
  await h.store.updateChat(conversation.chatId, ({ metadata }) => ({
    metadata: {
      ...metadata,
      zukhruf: {
        ...(metadata!.zukhruf as Record<string, unknown>),
        scheduling: {
          version: 1,
          cron: {
            deadbeef: {
              id: 'deadbeef',
              expression: '0 0 1 * *',
              prompt: 'expired prompt',
              recurring: true,
              timezone: 'UTC',
              createdAt: now,
              expiresAt: now + 7 * 24 * 60 * 60 * 1_000,
              nextRunAt: now + 20 * 24 * 60 * 60 * 1_000,
              generation: 1,
            },
          },
        },
      },
    },
  }));
  await using _worker = await runtime.work();
  assert.equal(scheduler.wakes.size, 0);
  await runTurn(runtime, h.queue, conversation, 'list expired');
  const result = (await runtime.observe(conversation).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.deepEqual(result?.output, { jobs: [] });
});

test(
  'duplicate wake delivery across runtimes advances PostgreSQL state once',
  { skip: dockerAvailable ? false : 'Docker is unavailable' },
  async (t) => {
    await withPostgresContainer(async (container) => {
      const firstStore = new PostgresContextStore({
        pool: container.connectionString,
      });
      const secondStore = new PostgresContextStore({
        pool: container.connectionString,
      });
      await firstStore.initialize();
      await secondStore.initialize();
      const scheduler = new RecordingWakeScheduler();
      const h = harness(t, scheduler, firstStore);
      const commands = new Map<string, { name: string; input: unknown }>([
        [
          'schedule postgres duplicate',
          {
            name: 'ScheduleWakeup',
            input: {
              delaySeconds: 60,
              reason: 'concurrency proof',
              prompt: 'postgres scheduled prompt',
            },
          },
        ],
      ]);
      const seenUserText: string[] = [];
      const declaration = defineAgent({
        name: 'root',
        model: toolModel(commands, seenUserText),
        sandbox: async () => ({}) as AgentSandbox,
        instructions: [],
      });
      const firstRuntime = new AgentRuntime(declaration, {
        ...h,
        scheduling: { scheduler, timezone: 'UTC' },
      });
      const secondRuntime = new AgentRuntime(declaration, {
        ...h,
        store: secondStore,
        scheduling: { scheduler, timezone: 'UTC' },
      });
      const conversation = {
        chatId: 'postgres-duplicate',
        userId: 'user-1',
      };
      const firstWorker = await firstRuntime.work();
      let secondWorker: AsyncDisposable | undefined;
      try {
        await runTurn(
          firstRuntime,
          h.queue,
          conversation,
          'schedule postgres duplicate',
        );
        secondWorker = await secondRuntime.work();
        assert.equal(scheduler.handlers.size, 2);
        const wake = [...scheduler.wakes.values()][0];
        await scheduler.deliverAcrossConsumers(wake.id);
        assert.equal(h.queue.turns.length, 2);

        await h.queue.runNext();
        await h.queue.runNext();
        assert.equal(
          seenUserText.filter((text) => text === 'postgres scheduled prompt')
            .length,
          1,
        );
        const chat = await secondStore.getChat(conversation.chatId);
        assert.equal(dynamicState(chat?.metadata), undefined);
      } finally {
        await secondWorker?.[Symbol.asyncDispose]();
        await firstWorker[Symbol.asyncDispose]();
        await secondStore.close();
        await firstStore.close();
      }
    });
  },
);
