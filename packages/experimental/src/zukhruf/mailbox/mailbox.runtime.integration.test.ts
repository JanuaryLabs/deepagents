import { PGlite } from '@electric-sql/pglite';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  type AgentSandbox,
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
  type StreamStore,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  MessageDeliveryMode,
  PgBossTurnQueue,
  SqliteMailboxStore,
  type TurnRef,
  createInterAgentCommunication,
} from '@deepagents/experimental/zukhruf';

function streamsFor(store: StreamStore): StreamManager {
  return new StreamManager({
    store,
    changeSource: new PollingChangeSource({ reads: store }),
  });
}

const root = { chatId: 'root', userId: 'user-1' };
const researcher = { chatId: 'researcher', userId: 'user-1' };
const reviewer = { chatId: 'reviewer', userId: 'user-1' };

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

async function runtimeHarness(
  model: AgentDeclaration['model'],
  options?: {
    turnQueue?: (
      boss: PgBoss,
      mailboxStore: SqliteMailboxStore,
    ) => PgBossTurnQueue;
  },
) {
  const declaration: AgentDeclaration = {
    name: 'researcher',
    model,
    sandbox: async (): Promise<AgentSandbox> =>
      createBashTool({
        sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      }),
    instructions: [],
  };
  const pglite = new PGlite();
  const boss = new PgBoss({ db: fromPglite(pglite), backend: 'pglite' });
  boss.on('error', () => {});
  await boss.start();
  const mailboxStore = new SqliteMailboxStore(':memory:');
  const turnQueue =
    options?.turnQueue?.(boss, mailboxStore) ??
    new PgBossTurnQueue(boss, {
      pollingIntervalSeconds: 0.5,
      schema: 'pgboss',
    });
  await turnQueue.initialize();
  const streamStore = new SqliteStreamStore(':memory:');
  const runtime = new AgentRuntime(declaration, {
    store: new InMemoryContextStore(),
    streams: streamsFor(streamStore),
    queue: turnQueue,
    mailboxStore,
  });
  return {
    runtime,
    boss,
    turnQueue,
    streamStore,
    mailboxStore,
    async [Symbol.asyncDispose]() {
      await boss.stop({ graceful: false });
      await pglite.close();
      streamStore.close();
      mailboxStore.close();
    },
  };
}

async function drainStream(stream: ReadableStream): Promise<void> {
  for await (const _part of stream) {
    // Execution is driven by the runtime; this only waits for terminal output.
  }
}

async function waitForStatus(
  store: SqliteStreamStore,
  id: string,
  expected: string,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if ((await store.getStreamStatus(id)) === expected) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${id} to become ${expected}`);
}

describe('zukhruf runtime mailbox delivery', () => {
  it('lets the owning conversation cancel a queued mailbox wake', async () => {
    await using h = await runtimeHarness(
      new MockLanguageModelV4({
        doStream: async () => {
          throw new Error('cancelled mailbox wake must not sample the model');
        },
      }),
    );
    await h.runtime.deliver(
      createInterAgentCommunication({
        author: root,
        recipient: researcher,
        content: 'cancel this wake',
      }),
      MessageDeliveryMode.TriggerTurn,
    );
    const jobs = await h.boss.findJobs(h.turnQueue.queue, {
      key: researcher.chatId,
    });
    const wake = jobs[0]?.data as TurnRef | undefined;
    assert.ok(wake);
    assert.equal(wake?.kind, 'mailbox');

    await h.runtime.observe(researcher).cancel(wake.streamId);

    assert.equal(
      await h.streamStore.getStreamStatus(wake.streamId),
      'cancelled',
    );
  });

  it('schedules one mailbox turn and makes all accumulated mail model-visible in FIFO order', async (t) => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'received' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ],
          }),
        };
      },
    });
    const wakePushObservations: boolean[] = [];
    class DurabilityRecordingQueue extends PgBossTurnQueue {
      readonly #mailbox: SqliteMailboxStore;

      constructor(boss: PgBoss, mailbox: SqliteMailboxStore) {
        super(boss, {
          pollingIntervalSeconds: 0.5,
          schema: 'pgboss',
        });
        this.#mailbox = mailbox;
      }

      override async push(turn: TurnRef) {
        if (turn.kind === 'mailbox') {
          wakePushObservations.push(await this.#mailbox.hasPending(researcher));
        }
        return super.push(turn);
      }
    }
    await using h = await runtimeHarness(model, {
      turnQueue: (boss, mailboxStore) =>
        new DurabilityRecordingQueue(boss, mailboxStore),
    });
    for (let index = 1; index <= 3; index++) {
      await h.runtime.deliver(
        createInterAgentCommunication({
          author: root,
          recipient: researcher,
          content: `message ${index}`,
        }),
        MessageDeliveryMode.QueueOnly,
      );
    }

    assert.deepStrictEqual(
      await h.boss.findJobs(h.turnQueue.queue, { key: researcher.chatId }),
      [],
      'queue-only mail does not schedule execution',
    );

    await h.runtime.deliver(
      createInterAgentCommunication({
        author: root,
        recipient: researcher,
        content: 'message 4',
      }),
      MessageDeliveryMode.TriggerTurn,
    );

    const jobs = await h.boss.findJobs(h.turnQueue.queue, {
      key: researcher.chatId,
    });
    assert.equal(
      jobs.length,
      1,
      'one trigger schedules exactly one target turn',
    );
    const wake = jobs[0]?.data as TurnRef | undefined;
    assert.equal(wake?.kind, 'mailbox');
    assert.deepStrictEqual(
      wakePushObservations,
      [true],
      'the communication is durable before the wake is queued',
    );

    await using _worker = await h.runtime.work();
    await t.waitFor(() => assert.equal(prompts.length, 1), {
      interval: 20,
      timeout: 5_000,
    });

    const renderedPrompt = JSON.stringify(prompts[0]);
    const positions = [1, 2, 3, 4].map((index) =>
      renderedPrompt.indexOf(`message ${index}`),
    );
    assert.ok(positions.every((position) => position >= 0));
    assert.deepStrictEqual(
      positions.toSorted((a, b) => a - b),
      positions,
    );
    await waitForStatus(h.streamStore, wake!.streamId, 'completed');
    const resumed = await h.runtime.observe(researcher).resume();
    assert.ok(
      resumed,
      'the owning conversation can reconnect to a mailbox turn',
    );
    await drainStream(resumed);
    const history = await h.runtime.observe(researcher).engine.getMessages();
    const mailboxHistory = history.filter(
      (message) =>
        message.role === 'user' &&
        message.parts.some(
          (part) =>
            part.type === 'text' && part.text.startsWith('Message Type:'),
        ),
    );
    assert.equal(
      mailboxHistory.length,
      4,
      'each consumed communication is recorded as its own history item',
    );
    assert.deepStrictEqual(
      mailboxHistory.map((message) => message.parts.length),
      [1, 1, 1, 1],
    );
    assert.deepStrictEqual(
      mailboxHistory.map(
        (message) =>
          (
            message.metadata as {
              interAgentCommunication: { content: string };
            }
          ).interAgentCommunication.content,
      ),
      ['message 1', 'message 2', 'message 3', 'message 4'],
    );
    const consumed = history
      .filter((message) => message.role === 'user')
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === 'text' ? [part.text] : [],
        ),
      )
      .join('\n');
    const historyPositions = [1, 2, 3, 4].map((index) =>
      consumed.indexOf(`message ${index}`),
    );
    assert.deepStrictEqual(
      historyPositions.toSorted((a, b) => a - b),
      historyPositions,
      'consumed mail is durable model history in delivery order',
    );
    assert.equal(
      await h.mailboxStore.hasPending(researcher),
      false,
      'consumed mail is not delivered twice',
    );
    assert.equal(await h.mailboxStore.hasPending(reviewer), false);
  });

  it('serializes mail behind an active target and exposes it at the next supported turn boundary', async (t) => {
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const prompts: unknown[] = [];
    let active = 0;
    let maxActive = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const call = prompts.push(prompt);
        return {
          stream: new ReadableStream({
            async start(controller) {
              active++;
              maxActive = Math.max(maxActive, active);
              if (call === 1) {
                firstStarted.resolve();
                await releaseFirst.promise;
              }
              controller.enqueue({ type: 'text-start', id: `text-${call}` });
              controller.enqueue({
                type: 'text-delta',
                id: `text-${call}`,
                delta: `reply ${call}`,
              });
              controller.enqueue({ type: 'text-end', id: `text-${call}` });
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              });
              active--;
              controller.close();
            },
          }),
        };
      },
    });
    await using h = await runtimeHarness(model);
    await using _worker = await h.runtime.work({ concurrency: 2 });

    const running = await h.runtime.enqueue(researcher, {
      id: 'active-turn',
      input: 'already working',
    });
    await firstStarted.promise;

    await h.runtime.deliver(
      createInterAgentCommunication({
        author: root,
        recipient: researcher,
        content: 'queued during active turn',
      }),
      MessageDeliveryMode.QueueOnly,
    );
    await h.runtime.deliver(
      createInterAgentCommunication({
        author: root,
        recipient: researcher,
        content: 'wake after active turn',
      }),
      MessageDeliveryMode.TriggerTurn,
    );

    await sleep(700);
    assert.equal(
      prompts.length,
      1,
      'no concurrent turn started for the target',
    );
    releaseFirst.resolve();
    await drainStream(running.stream);

    await t.waitFor(() => assert.equal(prompts.length, 2), {
      interval: 20,
      timeout: 5_000,
    });
    assert.equal(maxActive, 1);
    const secondPrompt = JSON.stringify(prompts[1]);
    assert.ok(secondPrompt.includes('queued during active turn'));
    assert.ok(secondPrompt.includes('wake after active turn'));
    assert.ok(
      secondPrompt.indexOf('queued during active turn') <
        secondPrompt.indexOf('wake after active turn'),
    );
  });
});
