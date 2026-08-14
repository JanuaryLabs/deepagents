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
  pushFailuresRemaining = 0;
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
  #nextActivityRead?: {
    started: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  };
  #running?: TurnRef;
  #options?: ConsumeOptions;

  pauseNextActivityRead() {
    const gate = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    this.#nextActivityRead = gate;
    return {
      started: gate.started.promise,
      release: () => gate.release.resolve(),
    };
  }

  override async push(turn: TurnRef) {
    if (this.pushFailuresRemaining > 0) {
      this.pushFailuresRemaining--;
      throw new Error('simulated turn enqueue outage');
    }
    this.turns.push(turn);
    return { jobId: turn.streamId, inserted: true };
  }

  override async getTurnActivity(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<'idle' | 'queued' | 'running'> {
    const gate = this.#nextActivityRead;
    if (gate) {
      this.#nextActivityRead = undefined;
      gate.started.resolve();
      await gate.release.promise;
    }
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
  #nextSchedule?: {
    started: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  };
  scheduleFailuresRemaining = 0;

  get handler(): ((wake: Wake<SchedulingWake>) => Promise<void>) | undefined {
    return this.handlers.values().next().value;
  }

  pauseNextSchedule() {
    const gate = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    this.#nextSchedule = gate;
    return {
      started: gate.started.promise,
      release: () => gate.release.resolve(),
    };
  }

  override async schedule(wake: Wake<SchedulingWake>): Promise<void> {
    if (this.scheduleFailuresRemaining > 0) {
      this.scheduleFailuresRemaining--;
      throw new Error('simulated wake insertion outage');
    }
    const gate = this.#nextSchedule;
    if (gate) {
      this.#nextSchedule = undefined;
      gate.started.resolve();
      await gate.release.promise;
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

class FailOnceDispatchClearStore extends InMemoryContextStore {
  failNextDispatchClear = false;

  override updateChat(
    chatId: string,
    update: ChatUpdater,
  ): Promise<StoredChatData> {
    return super.updateChat(chatId, (chat) => {
      const result = update(chat);
      if (
        this.failNextDispatchClear &&
        dispatchingState(chat.metadata) !== undefined &&
        dispatchingState(result?.metadata) === undefined
      ) {
        this.failNextDispatchClear = false;
        throw new Error('simulated dispatch cleanup outage');
      }
      return result;
    });
  }
}

function dispatchingState(
  metadata: Record<string, unknown> | undefined,
): unknown {
  return storedSchedulingState(metadata)?.dispatching;
}

function dynamicState(metadata: Record<string, unknown> | undefined): unknown {
  return storedSchedulingState(metadata)?.dynamic;
}

function storedSchedulingState(
  metadata: Record<string, unknown> | undefined,
): { dispatching?: unknown; dynamic?: unknown } | undefined {
  const zukhruf = metadata?.zukhruf;
  if (typeof zukhruf !== 'object' || zukhruf === null) return;
  const scheduling = (zukhruf as { scheduling?: unknown }).scheduling;
  if (typeof scheduling !== 'object' || scheduling === null) return;
  return scheduling;
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
  const resources = disposableHarness(scheduler, store);
  t.after(() => resources[Symbol.dispose]());
  return resources;
}

function disposableHarness(
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
  return {
    store,
    streams,
    mailboxStore,
    queue,
    [Symbol.dispose]() {
      streamStore.close();
      mailboxStore.close();
    },
  };
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

test('configured runtime injects top-level Claude-compatible scheduling tools', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  let modelTools: LanguageModelV4FunctionTool[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      modelTools = Array.isArray(tools)
        ? tools.filter(
            (candidate): candidate is LanguageModelV4FunctionTool =>
              candidate.type === 'function',
          )
        : [];
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
      multiAgent: { toolNamespace: 'agents' },
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );

  await runtime.enqueue(
    { chatId: 'scheduled-tools', userId: 'user-1' },
    { id: 'turn-1', input: 'show tools' },
  );
  await using _worker = await runtime.work();
  await h.queue.runNext();

  const schedulingTools = modelTools.filter(({ name }) =>
    ['CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup'].includes(name),
  );
  assert.deepEqual(schedulingTools.map(({ name }) => name).toSorted(), [
    'CronCreate',
    'CronDelete',
    'CronList',
    'ScheduleWakeup',
  ]);
  for (const schedulingTool of schedulingTools) {
    assert.equal(schedulingTool.providerOptions?.openai?.namespace, undefined);
  }
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
  const cronWake = [...scheduler.wakes.values()][0];
  const definitionId = cronWake.data.definitionId;
  assert.match(
    definitionId ?? '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

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
        nextRunAt: cronWake.runAt.getTime(),
        timezone: 'Asia/Amman',
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

test('CronCreate reports the exact next run and timezone for a one-shot cron', async (t) => {
  mock.timers.enable({ apis: ['Date'] });
  mock.timers.setTime(new Date('2026-08-13T12:09:00Z').getTime());
  t.after(() => mock.timers.reset());

  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create passed one shot',
      {
        name: 'CronCreate',
        input: {
          cron: '8 15 13 8 *',
          prompt: 'run once',
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
      scheduling: { scheduler, timezone: 'Asia/Amman' },
    },
  );
  const conversation = { chatId: 'passed-one-shot', userId: 'user-1' };
  await using _worker = await runtime.work();

  await runTurn(runtime, h.queue, conversation, 'create passed one shot');

  const result = (await runtime.observe(conversation).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.deepEqual(result?.output, {
    id: [...scheduler.wakes.values()][0].data.definitionId,
    humanSchedule: 'At 03:08 PM, on day 13 of the month, only in August',
    nextRunAt: new Date('2027-08-13T12:08:00Z').getTime(),
    timezone: 'Asia/Amman',
    recurring: false,
  });
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

test('ScheduleWakeup fires an ask and persists scheduled provenance', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'schedule dynamic',
      {
        name: 'ScheduleWakeup',
        input: {
          delaySeconds: 600,
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
    { clampedDelaySeconds: 600, wasClamped: false },
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

test('ScheduleWakeup rejects delays outside its supported window', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'schedule immediately',
      {
        name: 'ScheduleWakeup',
        input: {
          delaySeconds: 0,
          reason: 'invalid immediate wake',
          prompt: 'must not be scheduled',
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
  const conversation = { chatId: 'invalid-dynamic-delay', userId: 'user-1' };
  await using _worker = await runtime.work();

  await runTurn(runtime, h.queue, conversation, 'schedule immediately');

  assert.equal(scheduler.wakes.size, 0);
  const result = (await runtime.observe(conversation).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.equal(result?.state, 'output-error');
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
          cron: {
            '00000000-0000-4000-8000-000000000001': {
              id: '00000000-0000-4000-8000-000000000001',
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
      ({ data }) =>
        data.definitionId === '00000000-0000-4000-8000-000000000001',
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

test('failed wake insertion does not commit a cron definition', async (t) => {
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
  const conversation = { chatId: 'create-gap', userId: 'user-1' };
  await using _worker = await runtime.work();
  scheduler.scheduleFailuresRemaining = 1;
  await runTurn(runtime, h.queue, conversation, 'create during outage');
  assert.equal(scheduler.wakes.size, 0);
  const chat = await h.store.getChat(conversation.chatId);
  assert.equal(
    (chat?.metadata?.zukhruf as { scheduling?: unknown }).scheduling,
    undefined,
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
  assert.ok(!('version' in scheduling));
});

test('retry after enqueue-before-dispatch-clear executes one scheduled turn', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const store = new FailOnceDispatchClearStore();
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

  store.failNextDispatchClear = true;
  await assert.rejects(scheduler.fire(wake.id), /dispatch cleanup outage/);
  assert.equal(h.queue.turns.length, 1);
  await scheduler.fire(wake.id);
  assert.equal(
    h.queue.turns.length,
    1,
    'the queued occurrence makes the retry ineligible to materialize again',
  );

  await h.queue.runNext();
  assert.equal(
    h.queue.turns.length,
    1,
    'settlement retries the durable dispatch with the same turn identity',
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

test('retry after claim-before-enqueue executes one scheduled turn', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'schedule claim crash window',
      {
        name: 'ScheduleWakeup',
        input: {
          delaySeconds: 60,
          reason: 'exercise durable claim',
          prompt: 'claimed scheduled prompt',
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
  const conversation = { chatId: 'claim-enqueue-gap', userId: 'user-1' };
  await using _worker = await runtime.work();
  await runTurn(runtime, h.queue, conversation, 'schedule claim crash window');
  const wake = [...scheduler.wakes.values()][0];

  h.queue.pushFailuresRemaining = 1;
  await assert.rejects(scheduler.fire(wake.id), /turn enqueue outage/);
  assert.equal(h.queue.turns.length, 0);

  await scheduler.fire(wake.id);
  assert.equal(h.queue.turns.length, 1);
  await h.queue.runNext();
  assert.equal(
    seenUserText.filter((text) => text === 'claimed scheduled prompt').length,
    1,
  );
});

test('deleting a claimed cron before materialization prevents its scheduled ask', async () => {
  const scheduler = new RecordingWakeScheduler();
  using h = disposableHarness(scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create deletion race',
      {
        name: 'CronCreate',
        input: { cron: '* * * * *', prompt: 'cancelled scheduled prompt' },
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
  const conversation = { chatId: 'claimed-delete-race', userId: 'user-1' };
  await using _worker = await runtime.work();
  await runTurn(runtime, h.queue, conversation, 'create deletion race');
  const wake = [...scheduler.wakes.values()][0];
  assert.ok(wake.data.definitionId);
  commands.set('delete claimed cron', {
    name: 'CronDelete',
    input: { id: wake.data.definitionId },
  });

  const gate = h.queue.pauseNextActivityRead();
  const delivery = scheduler.fire(wake.id);
  await gate.started;
  await runTurn(runtime, h.queue, conversation, 'delete claimed cron');
  gate.release();
  await delivery;

  assert.deepEqual(
    h.queue.turns.map((turn) => (turn.kind === 'ask' ? turn.input : turn.kind)),
    [],
  );
});

test('deleting a claimed cron during successor insertion prevents its scheduled ask', async () => {
  const scheduler = new RecordingWakeScheduler();
  using h = disposableHarness(scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create successor race',
      {
        name: 'CronCreate',
        input: { cron: '* * * * *', prompt: 'cancelled successor prompt' },
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
  const conversation = { chatId: 'successor-delete-race', userId: 'user-1' };
  await using _worker = await runtime.work();
  await runTurn(runtime, h.queue, conversation, 'create successor race');
  const wake = [...scheduler.wakes.values()][0];
  assert.ok(wake.data.definitionId);
  commands.set('delete successor race', {
    name: 'CronDelete',
    input: { id: wake.data.definitionId },
  });

  const gate = scheduler.pauseNextSchedule();
  const delivery = scheduler.fire(wake.id);
  await gate.started;
  await runTurn(runtime, h.queue, conversation, 'delete successor race');
  gate.release();
  await delivery;

  assert.deepEqual(
    h.queue.turns.map((turn) => (turn.kind === 'ask' ? turn.input : turn.kind)),
    [],
  );
  const staleSuccessor = [...scheduler.wakes.values()][0];
  assert.ok(staleSuccessor);
  await scheduler.fire(staleSuccessor.id);
  assert.equal(h.queue.turns.length, 0);
});

test('failed successor insertion leaves the current cron retryable', async (t) => {
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

  scheduler.scheduleFailuresRemaining = 1;
  await assert.rejects(scheduler.fire(first.id), /wake insertion outage/);
  assert.equal(h.queue.turns.length, 0);

  await scheduler.fire(first.id);
  assert.equal(h.queue.turns.length, 1);
  assert.ok(
    [...scheduler.wakes.values()].some(
      ({ data }) =>
        data.definitionId === first.data.definitionId &&
        data.generation === first.data.generation + 1,
    ),
    'the successful retry arms the successor',
  );
  await h.queue.runNext();
  assert.equal(
    seenUserText.filter((text) => text === 'successor prompt').length,
    1,
  );
});

test('pg-boss can retry successor insertion through a prolonged outage', async () => {
  const scheduler = new RecordingWakeScheduler();
  using h = disposableHarness(scheduler);
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create prolonged outage cron',
      {
        name: 'CronCreate',
        input: { cron: '* * * * *', prompt: 'prolonged outage prompt' },
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
  const conversation = { chatId: 'prolonged-successor-gap', userId: 'user-1' };
  await using _worker = await runtime.work();
  await runTurn(runtime, h.queue, conversation, 'create prolonged outage cron');
  const first = [...scheduler.wakes.values()][0];

  scheduler.scheduleFailuresRemaining = 2;
  await assert.rejects(scheduler.fire(first.id), /wake insertion outage/);
  await assert.rejects(scheduler.fire(first.id), /wake insertion outage/);
  await scheduler.fire(first.id);

  assert.ok(
    [...scheduler.wakes.values()].some(
      ({ data }) =>
        data.definitionId === first.data.definitionId &&
        data.generation === first.data.generation + 1,
    ),
    'the successful retry should persist the successor receipt',
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
          delaySeconds: 3_600,
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
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create catch-up cron',
      {
        name: 'CronCreate',
        input: { cron: '*/10 * * * *', prompt: 'cancel catch-up' },
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
  const conversation = { chatId: 'cancel-user-for-cron', userId: 'user-1' };
  await using _worker = await runtime.work();
  await runTurn(runtime, h.queue, conversation, 'create catch-up cron');
  const wake = [...scheduler.wakes.values()][0];
  const queued = await runtime.enqueue(conversation, {
    id: 'cancel-user-turn',
    input: 'cancel me',
  });
  mock.timers.tick(10 * 60_000);
  await scheduler.fire(wake.id);
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
  const commands = new Map<string, { name: string; input: unknown }>([
    [
      'create approval cron',
      {
        name: 'CronCreate',
        input: { cron: '*/10 * * * *', prompt: 'approval catch-up' },
      },
    ],
    ['needs approval', { name: 'publish', input: {} }],
  ]);
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(commands, []),
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
  await using _worker = await runtime.work();
  await runTurn(runtime, h.queue, conversation, 'create approval cron');
  const wake = [...scheduler.wakes.values()][0];
  await runTurn(runtime, h.queue, conversation, 'needs approval');
  mock.timers.tick(10 * 60_000);
  await scheduler.fire(wake.id);
  assert.deepEqual(h.queue.turns, []);

  await runtime.approve(conversation, {
    toolCallId: 'call-publish-needs approval',
  });
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

test('resume ignores scheduling metadata while scheduling tools fail closed', async (t) => {
  const scheduler = new RecordingWakeScheduler();
  const h = harness(t, scheduler);
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: toolModel(
        new Map([['list malformed', { name: 'CronList', input: {} }]]),
        [],
      ),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
    }),
    {
      ...h,
      scheduling: { scheduler, timezone: 'UTC' },
    },
  );
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
  await using _worker = await runtime.work();
  assert.equal(await runtime.observe(conversation).resume(), null);
  await assert.rejects(
    runTurn(runtime, h.queue, conversation, 'list malformed'),
    /Invalid metadata\.zukhruf\.scheduling state/,
  );
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
      const id = crypto.randomUUID();
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
        scheduling: { cron },
      },
    },
  }));
  await using _worker = await runtime.work();
  assert.equal(scheduler.wakes.size, 0);

  await runTurn(runtime, h.queue, conversation, 'create fifty first');
  assert.equal(scheduler.wakes.size, 0);
  const result = (await runtime.observe(conversation).engine.getMessages())
    .at(-1)!
    .parts.find(isToolUIPart);
  assert.equal(result?.state, 'output-error');
});

test('a dynamic wake remains usable across a context-store restart', async (t) => {
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

test('a cron wake remains usable across a context-store restart', async (t) => {
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
  const persisted = [...scheduler.wakes.values()][0];

  await scheduler.fire(persisted.id);
  assert.equal(h.queue.turns.length, 1);
  const successor = [...scheduler.wakes.values()][0];
  assert.ok(successor.runAt.getTime() > Date.now());
  await h.queue.runNext();
  assert.equal(
    seenUserText.filter((text) => text === 'catch-up prompt').length,
    1,
  );
});

test('a recurring cron does not fire when its first occurrence is beyond its seven-day expiry', async () => {
  mock.timers.enable({ apis: ['Date'] });
  try {
    mock.timers.setTime(new Date('2026-08-13T00:00:00Z').getTime());
    const scheduler = new RecordingWakeScheduler();
    using h = disposableHarness(scheduler);
    const commands = new Map<string, { name: string; input: unknown }>([
      [
        'create sparse cron',
        {
          name: 'CronCreate',
          input: { cron: '0 0 1 * *', prompt: 'expired monthly prompt' },
        },
      ],
      ['list sparse cron', { name: 'CronList', input: {} }],
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
    const conversation = { chatId: 'sparse-expiry', userId: 'user-1' };
    await using _worker = await runtime.work();
    await runTurn(runtime, h.queue, conversation, 'create sparse cron');
    const wake = [...scheduler.wakes.values()][0];
    assert.ok(wake.runAt.getTime() > Date.now() + 7 * 24 * 60 * 60 * 1_000);

    mock.timers.setTime(wake.runAt.getTime());
    await scheduler.fire(wake.id);
    assert.deepEqual(h.queue.turns, []);

    await runTurn(runtime, h.queue, conversation, 'list sparse cron');
    const result = (await runtime.observe(conversation).engine.getMessages())
      .at(-1)!
      .parts.find(isToolUIPart);
    assert.deepEqual(result?.output, { jobs: [] });
  } finally {
    mock.timers.reset();
  }
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
