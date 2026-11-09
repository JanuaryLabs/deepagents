import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { open } from '@zukhruf/sqlite-open';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { SqliteContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  AgentRuntime,
  SqliteMailboxStore,
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

import { buildSandbox } from '../../../testing/build-sandbox.fixture.ts';
import {
  ControlledTurnQueue,
  type TurnConsumer,
} from '../../../testing/controlled-turn-queue.fixture.ts';
import { streamsFor } from '../../../testing/streams-for.fixture.ts';
import { usage } from '../../../testing/usage.fixture.ts';
import { userTurn } from '../../../testing/user-turn.fixture.ts';

class RecordingWakeScheduler extends WakeScheduler<SchedulingWake> {
  readonly scheduled: Wake<SchedulingWake>[] = [];
  readonly #handlers = new Set<(wake: Wake<SchedulingWake>) => Promise<void>>();

  override async schedule(wake: Wake<SchedulingWake>): Promise<void> {
    this.scheduled.push(wake);
  }

  override async cancel(): Promise<void> {}

  override async consume(
    handler: (wake: Wake<SchedulingWake>) => Promise<void>,
  ): Promise<AsyncDisposable> {
    this.#handlers.add(handler);
    return {
      [Symbol.asyncDispose]: async () => {
        this.#handlers.delete(handler);
      },
    };
  }

  async deliver(wake: Wake<SchedulingWake>): Promise<void> {
    const [handler] = this.#handlers;
    assert.ok(handler, 'expected a running wake consumer');
    await handler(wake);
  }
}

class SettlingTurnQueue extends ControlledTurnQueue {
  protected override async deliver(
    turn: TurnRef,
    consumer: TurnConsumer,
  ): Promise<void> {
    await super.deliver(turn, consumer);
    await consumer.options.onSettled?.(turn);
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

/** `metadata.zukhruf.scheduling` as the conversation scheduler writes it. */
const cronMetadataSchema = z.looseObject({
  zukhruf: z.looseObject({
    scheduling: z
      .looseObject({
        cron: z.record(
          z.string(),
          z.looseObject({ generation: z.number(), nextRunAt: z.number() }),
        ),
      })
      .optional(),
  }),
});

function cronDefinition(
  metadata: Record<string, unknown> | undefined,
  definitionId: string,
) {
  const definition =
    cronMetadataSchema.safeParse(metadata).data?.zukhruf.scheduling?.cron[
      definitionId
    ];
  assert.ok(definition, `expected cron definition ${definitionId}`);
  return definition;
}

test('one runtime neither discovers nor consumes another runtime cron', async () => {
  const database = open(':memory:');
  const store = new SqliteContextStore(database);
  const schedulerA = new RecordingWakeScheduler();
  const schedulerB = new RecordingWakeScheduler();
  const queueA = new SettlingTurnQueue();
  const queueB = new SettlingTurnQueue();
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
      sandbox: buildSandbox,
      instructions: [],
      plugins: [conversationScheduling()],
    }),
  );
  const runtimeAStack = defineStack(async () => ({
    store,
    streams: streamsFor(streamStoreA),
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
      sandbox: buildSandbox,
      instructions: [],
      plugins: [conversationScheduling()],
    }),
  );
  const runtimeBStack = defineStack(async () => ({
    store,
    streams: streamsFor(streamStoreB),
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
    await runtimeB.enqueue(
      conversationB,
      userTurn('create-b-cron-turn', 'create B cron'),
    );
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
