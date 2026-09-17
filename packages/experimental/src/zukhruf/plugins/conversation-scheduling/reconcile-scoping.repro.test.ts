import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  type AgentSandbox,
  PollingChangeSource,
  SqliteContextStore,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';
import {
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  SqliteMailboxStore,
  TurnQueue,
  type TurnRef,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import {
  type SchedulingWake,
  type Wake,
  WakeScheduler,
  conversationScheduling,
  conversationSchedulingCapabilities,
} from '@deepagents/experimental/zukhruf/conversation-scheduling';

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

class RecordingWakeScheduler extends WakeScheduler<SchedulingWake> {
  readonly scheduled: Wake<SchedulingWake>[] = [];
  #handler?: (wake: Wake<SchedulingWake>) => Promise<void>;

  override async schedule(wake: Wake<SchedulingWake>): Promise<void> {
    this.scheduled.push(wake);
  }

  override async cancel(): Promise<void> {}

  override async consume(
    handler: (wake: Wake<SchedulingWake>) => Promise<void>,
  ): Promise<AsyncDisposable> {
    this.#handler = handler;
    return {
      [Symbol.asyncDispose]: async () => {
        this.#handler = undefined;
      },
    };
  }

  async deliver(wake: Wake<SchedulingWake>): Promise<void> {
    assert.ok(this.#handler, 'expected a running wake consumer');
    await this.#handler(wake);
  }
}

class RecordingTurnQueue extends TurnQueue {
  readonly turns: TurnRef[] = [];
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
  #options?: ConsumeOptions;

  override async push(turn: TurnRef) {
    this.turns.push(turn);
  }

  override async getTurnActivity(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ) {
    return this.turns.some(
      (turn) =>
        turn.chatId === conversation.chatId &&
        turn.userId === conversation.userId,
    )
      ? ('queued' as const)
      : ('idle' as const);
  }

  override async getCurrentTurn(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ) {
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
    assert.ok(turn, 'expected a queued turn');
    assert.ok(this.#handler, 'expected a running turn consumer');
    await this.#handler(turn, {
      signal: new AbortController().signal,
      park: async () => assert.fail('turn unexpectedly parked'),
    });
    await this.#options?.onSettled?.(turn);
  }
}

function cronCreatingModel() {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call++;
      const chunks: LanguageModelV4StreamPart[] =
        call === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'create-b-cron',
                toolName: 'CronCreate',
                input: JSON.stringify({
                  cron: '*/5 * * * *',
                  prompt: 'B scheduled prompt',
                }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: '' },
                usage,
              },
            ]
          : [
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'done' },
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

function cronDefinition(
  metadata: Record<string, unknown> | undefined,
  definitionId: string,
) {
  const definition = (
    metadata?.zukhruf as {
      scheduling?: {
        cron?: Record<string, { generation: number; nextRunAt: number }>;
      };
    }
  )?.scheduling?.cron?.[definitionId];
  assert.ok(definition, `expected cron definition ${definitionId}`);
  return definition;
}

test('one runtime neither discovers nor consumes another runtime cron', async () => {
  const database = new DatabaseSync(':memory:');
  const store = new SqliteContextStore(database);
  const schedulerA = new RecordingWakeScheduler();
  const schedulerB = new RecordingWakeScheduler();
  const queueA = new RecordingTurnQueue();
  const queueB = new RecordingTurnQueue();
  const streamStoreA = new SqliteStreamStore(':memory:');
  const streamStoreB = new SqliteStreamStore(':memory:');
  const mailboxStoreA = new SqliteMailboxStore(':memory:');
  const mailboxStoreB = new SqliteMailboxStore(':memory:');
  const conversationA = {
    chatId: 'group:participant:A',
    userId: 'shared-user',
  };
  const conversationB = {
    chatId: 'group:participant:B',
    userId: 'shared-user',
  };
  const runtimeASetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({}),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      plugins: [conversationScheduling()],
    }),
  );
  const runtimeAStack = defineStack(async () => ({
    store,
    streams: new StreamManager({
      store: streamStoreA,
      changeSource: new PollingChangeSource({ reads: streamStoreA }),
    }),
    queue: queueA,
    mailboxStore: mailboxStoreA,
    bindings: [
      conversationSchedulingCapabilities.scheduler.bind(schedulerA),
      conversationSchedulingCapabilities.timezone.bind('UTC'),
    ],
  }));
  const runtimeA = await runtimeASetup.initialize(runtimeAStack);
  const runtimeBSetup = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: cronCreatingModel(),
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      plugins: [conversationScheduling()],
    }),
  );
  const runtimeBStack = defineStack(async () => ({
    store,
    streams: new StreamManager({
      store: streamStoreB,
      changeSource: new PollingChangeSource({ reads: streamStoreB }),
    }),
    queue: queueB,
    mailboxStore: mailboxStoreB,
    bindings: [
      conversationSchedulingCapabilities.scheduler.bind(schedulerB),
      conversationSchedulingCapabilities.timezone.bind('UTC'),
    ],
  }));
  const runtimeB = await runtimeBSetup.initialize(runtimeBStack);
  let workerA: AsyncDisposable | undefined;
  let workerB: AsyncDisposable | undefined;

  try {
    await runtimeA.createSession(conversationA);
    await runtimeB.createSession(conversationB);
    workerB = await runtimeB.work();
    await runtimeB.enqueue(conversationB, {
      message: {
        id: 'create-b-cron-turn',
        role: 'user',
        parts: [{ type: 'text', text: 'create B cron' }],
      },
      trigger: 'submit-message',
    });
    await queueB.runNext();

    const bWake = schedulerB.scheduled.at(-1);
    assert.ok(bWake, 'B should arm its cron');
    const definitionId = bWake.data.definitionId;
    assert.ok(definitionId, 'B cron wake should name its definition');
    const before = cronDefinition(
      (await store.getChat(conversationB.chatId))?.metadata,
      definitionId,
    );
    workerA = await runtimeA.work();

    assert.deepEqual(schedulerA.scheduled, []);
    await runtimeA.observe(conversationA).resume();
    await runtimeB.observe(conversationB).resume();
    assert.deepEqual(schedulerA.scheduled, []);
    assert.deepEqual(schedulerB.scheduled, [bWake]);

    await schedulerB.deliver(bWake);
    assert.deepEqual(queueA.turns, []);
    assert.equal(queueB.turns.at(-1)?.chatId, conversationB.chatId);

    const after = cronDefinition(
      (await store.getChat(conversationB.chatId))?.metadata,
      definitionId,
    );
    assert.equal(after.generation, before.generation + 1);
    assert.ok(after.nextRunAt > before.nextRunAt);
  } finally {
    await workerA?.[Symbol.asyncDispose]();
    await workerB?.[Symbol.asyncDispose]();
    mailboxStoreA.close();
    mailboxStoreB.close();
    streamStoreA.close();
    streamStoreB.close();
    database.close();
  }
});
