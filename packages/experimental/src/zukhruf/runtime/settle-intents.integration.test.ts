import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { createClock } from '@sinonjs/fake-timers';
import { Latch } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { type TestContext, suite, test } from 'node:test';
import { PgBoss } from 'pg-boss';

import {
  type AdmissionScope,
  type AgentDeclaration,
  type AgentPluginDefinition,
  AgentRuntime,
  AgentStorage,
  type AgentTree,
  EmbeddedAgentStorage,
  NonRetryableError,
  PgBossWakeScheduler,
  PostgresAgentStorage,
  type Wake,
  WakeScheduler,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import {
  type SchedulingWake,
  conversationScheduling,
  conversationSchedulingCapabilities,
} from '@deepagents/experimental/zukhruf/conversation-scheduling';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import {
  textResult,
  toolCallResult,
} from '../../testing/stream-results.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const testPostgres = new Postgres({ environment: process.env });

/** A storage and the pg-boss its queues run on. */
const storages = [
  {
    name: 'embedded',
    open: async (resources: AsyncDisposableStack) => {
      const directory = resources.use(
        await new TemporaryFiles().directory('zukhruf-'),
      );
      const storage = resources.use(
        await EmbeddedAgentStorage.open({ directory: directory.path }),
      );
      return { storage, boss: storage.boss };
    },
  },
  {
    name: 'postgres',
    open: async (resources: AsyncDisposableStack) => {
      const database = resources.use(await testPostgres.database());
      const boss = new PgBoss({ connectionString: database.connectionString });
      boss.on('error', () => {});
      await boss.start();
      resources.defer(() => boss.stop({ graceful: false }));
      const storage = resources.use(
        await PostgresAgentStorage.create({
          pool: database.pool(),
          boss,
          queue: { pollingIntervalSeconds: 0.5 },
        }),
      );
      return { storage, boss };
    },
  },
] satisfies {
  name: string;
  open(
    resources: AsyncDisposableStack,
  ): Promise<{ storage: AgentStorage; boss: PgBoss }>;
}[];

/** The queue of one follow-up's settle intents, named after the storages' default turn queue. */
const settleQueue = (followUp: string) => `zukhruf-turns-settle-${followUp}`;

/** Resolves once every intent of the queue is done: pg-boss deletes a job its worker completed. */
async function settled(boss: PgBoss, queue: string, t: TestContext) {
  await waitFor(
    async () => assert.deepStrictEqual(await boss.findJobs(queue), []),
    { signal: t.signal },
  );
}

/** The text of the last user message the model was sent. */
function lastUserText(prompt: LanguageModelV4Prompt): string {
  const message = prompt.findLast(({ role }) => role === 'user');
  if (message?.role !== 'user') return '';
  return message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('');
}

/**
 * Answers every turn, and calls CronCreate once on the turn that asks for it.
 * Once the cron exists, that turn runs on past its first occurrence, so the
 * occurrence falls due while the chat is busy.
 */
function cronModel(seen: string[], clock: { tick(ms: number): unknown }) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      if (prompt.at(-1)?.role === 'tool') {
        clock.tick(10 * 60_000);
        return textResult('created');
      }
      const text = lastUserText(prompt);
      seen.push(text);
      return text === 'create cron'
        ? toolCallResult({
            toolCallId: crypto.randomUUID(),
            toolName: 'CronCreate',
            input: JSON.stringify({
              cron: '*/10 * * * *',
              prompt: 'scheduled prompt',
            }),
          })
        : textResult(`done:${text}`);
    },
  });
}

/** The scheduling plugin's real wake queue; scheduling a cron's successor occurrence fails while `failing` is above zero. */
class FailingScheduler extends WakeScheduler<SchedulingWake> {
  failing: number;
  readonly #inner: WakeScheduler<SchedulingWake>;

  constructor(inner: WakeScheduler<SchedulingWake>, failing: number) {
    super();
    this.#inner = inner;
    this.failing = failing;
  }

  override async schedule(wake: Wake<SchedulingWake>): Promise<void> {
    if (wake.data.generation > 1 && this.failing > 0) {
      this.failing--;
      throw new Error('scheduling queue unreachable');
    }
    await this.#inner.schedule(wake);
  }

  override cancel(id: string): Promise<void> {
    return this.#inner.cancel(id);
  }

  override consume(
    handler: (wake: Wake<SchedulingWake>) => Promise<void>,
  ): Promise<AsyncDisposable> {
    return this.#inner.consume(handler);
  }
}

/** The scheduling plugin's real wake queue, which this worker never takes wakes from. */
class ScheduleOnlyScheduler extends WakeScheduler<SchedulingWake> {
  readonly #inner: WakeScheduler<SchedulingWake>;

  constructor(inner: WakeScheduler<SchedulingWake>) {
    super();
    this.#inner = inner;
  }

  override schedule(wake: Wake<SchedulingWake>): Promise<void> {
    return this.#inner.schedule(wake);
  }

  override cancel(id: string): Promise<void> {
    return this.#inner.cancel(id);
  }

  override async consume(): Promise<AsyncDisposable> {
    return { [Symbol.asyncDispose]: async () => {} };
  }
}

async function schedulingQueue(boss: PgBoss) {
  const queue = new PgBossWakeScheduler<SchedulingWake>(boss, {
    queue: 'zukhruf-scheduling',
    pollingIntervalSeconds: 0.5,
  });
  await queue.initialize();
  return queue;
}

/** A host of `root` on `storage` whose scheduling plugin schedules through `scheduler` and reads `clock`. */
async function schedulingHost(
  root: AgentDeclaration,
  plugin: AgentPluginDefinition,
  storage: AgentStorage,
  scheduler: WakeScheduler<SchedulingWake>,
  clock: { Date: { now(): number } },
) {
  return new AgentRuntime(root).initialize(
    defineStack(async () => ({
      storage,
      bindings: [
        conversationSchedulingCapabilities.scheduler.bind(scheduler),
        conversationSchedulingCapabilities.timezone.bind('UTC'),
        conversationSchedulingCapabilities.clock.bind(clock),
      ],
    })),
  );
}

/** A plugin whose availability runs `available` with the number of the call, from 1. */
function availability(
  name: string,
  available: (call: number) => Promise<void>,
): AgentPluginDefinition & { readonly calls: number } {
  let calls = 0;
  return {
    name,
    get calls() {
      return calls;
    },
    create: () => ({
      initialize: async () => ({
        conversationAvailable: () => available(++calls),
      }),
    }),
  };
}

/** Records the process warnings whose message names `text` while `body` runs. */
async function recordingWarnings<T>(
  text: string,
  body: (warnings: string[]) => Promise<T>,
): Promise<T> {
  const warnings: string[] = [];
  const record = (warning: Error) => {
    if (warning.message.includes(text)) warnings.push(warning.message);
  };
  process.on('warning', record);
  try {
    return await body(warnings);
  } finally {
    process.off('warning', record);
  }
}

function plainAgent(plugins: AgentPluginDefinition[], model = answering()) {
  return defineAgent({
    name: 'root',
    model,
    sandbox: buildSandbox(),
    instructions: [],
    plugins,
  });
}

function answering(gate?: Promise<unknown>) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      if (text === 'held') await gate;
      return textResult(`done:${text}`);
    },
  });
}

/** A real storage whose first settle intent write fails, as a store outage at that moment would. */
class FailFirstSettleWriteStorage extends AgentStorage {
  failedWrites = 0;
  readonly #inner: AgentStorage;

  constructor(inner: AgentStorage) {
    super();
    this.#inner = inner;
  }

  get store() {
    return this.#inner.store;
  }

  get streams() {
    return this.#inner.streams;
  }

  get queue() {
    return this.#inner.queue;
  }

  get mailboxStore() {
    return this.#inner.mailboxStore;
  }

  get sandboxIdleWakes() {
    return this.#inner.sandboxIdleWakes;
  }

  get deletedConversations() {
    return this.#inner.deletedConversations;
  }

  settleQueue(followUp: string) {
    return this.#inner.settleQueue(followUp);
  }

  admit<T>(
    tree: AgentTree,
    work: (scope: AdmissionScope) => Promise<T>,
  ): Promise<T> {
    return this.#inner.admit(tree, (scope) =>
      work({
        ...scope,
        settleIntents: {
          record: async (followUp, id, intent) => {
            if (this.failedWrites === 0) {
              this.failedWrites++;
              throw new Error('settle intent write failed');
            }
            await scope.settleIntents.record(followUp, id, intent);
          },
        },
      }),
    );
  }
}

for (const { name, open } of storages) {
  suite(`settle follow-ups run from durable intents (${name})`, () => {
    test("a turn's follow-up that its worker never finished runs on another runtime on the same storage: the cron occurrence that fell due while the turn ran dispatches there", async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage, boss } = await open(resources);
      const clock = createClock(Date.now());
      const plugin = conversationScheduling();
      const conversation = { chatId: 'crash-window', userId: 'u1' };
      const seen: string[] = [];
      const root = plainAgent([plugin], cronModel(seen, clock));
      // This worker can finish no follow-up of the turn, as one dying would not.
      const dying = await schedulingHost(
        root,
        plugin,
        storage,
        new FailingScheduler(
          await schedulingQueue(boss),
          Number.POSITIVE_INFINITY,
        ),
        clock,
      );
      await dying.work();
      await Array.fromAsync(
        (await dying.enqueue(conversation, userTurn('t-1', 'create cron')))
          .stream,
      );
      await dying[Symbol.asyncDispose]();

      await using next = await schedulingHost(
        root,
        plugin,
        storage,
        await schedulingQueue(boss),
        clock,
      );
      await next.work();

      await waitFor(() => assert.ok(seen.includes('scheduled prompt')), {
        signal: t.signal,
      });
      assert.deepStrictEqual(seen, ['create cron', 'scheduled prompt']);
    });

    test('an availability follow-up that fails once with an ordinary error is retried, and the cron occurrence that fell due while the turn ran dispatches', async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage, boss } = await open(resources);
      const clock = createClock(Date.now());
      const plugin = conversationScheduling();
      const conversation = { chatId: 'retried', userId: 'u1' };
      const seen: string[] = [];
      const scheduler = new FailingScheduler(await schedulingQueue(boss), 1);
      await using host = await schedulingHost(
        plainAgent([plugin], cronModel(seen, clock)),
        plugin,
        storage,
        scheduler,
        clock,
      );
      await host.work();

      await Array.fromAsync(
        (await host.enqueue(conversation, userTurn('t-1', 'create cron')))
          .stream,
      );

      await waitFor(() => assert.ok(seen.includes('scheduled prompt')), {
        signal: t.signal,
      });
      assert.deepStrictEqual(
        { seen, failing: scheduler.failing },
        { seen: ['create cron', 'scheduled prompt'], failing: 0 },
      );
    });

    test("a follow-up intent of a turn a later turn superseded is done without running: the later turn's own intent runs it", async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage, boss } = await open(resources);
      const laterEnded = new Latch();
      // The first attempt fails only once the later turn has run, so its retry
      // comes after that turn became the chat's latest.
      const plugin = availability('superseded', async (call) => {
        if (call !== 1) return;
        await laterEnded.wait();
        throw new Error('first availability attempt fails');
      });
      const release = new Latch();
      await using host = await new AgentRuntime(
        plainAgent([plugin], answering(release.wait())),
      ).initialize(defineStack(async () => ({ storage })));
      await host.work();
      const conversation = { chatId: 'superseded', userId: 'u1' };

      const earlier = await host.enqueue(conversation, userTurn('t-1', 'held'));
      const later = await host.enqueue(conversation, userTurn('t-2', 'later'));
      release.open();
      await Array.fromAsync(earlier.stream);
      await Array.fromAsync(later.stream);
      laterEnded.open();
      await waitFor(() => assert.ok(plugin.calls >= 2), { signal: t.signal });
      await settled(boss, settleQueue(plugin.name), t);

      // One failed attempt, and one run for the later turn: the earlier
      // turn's intent, retried after the later turn started, did not run.
      assert.equal(plugin.calls, 2);
    });

    test("a deleted chat's follow-up intent is done without running", async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage, boss } = await open(resources);
      const plugin = availability('deleted', async (call) => {
        if (call === 1) throw new Error('first availability attempt fails');
      });
      await using host = await new AgentRuntime(
        plainAgent([plugin]),
      ).initialize(defineStack(async () => ({ storage })));
      await host.work();
      const conversation = { chatId: 'deleted', userId: 'u1' };

      await Array.fromAsync(
        (await host.enqueue(conversation, userTurn('t-1', 'hello'))).stream,
      );
      await waitFor(() => assert.equal(plugin.calls, 1), { signal: t.signal });
      await host.deleteSession(conversation);
      await settled(boss, settleQueue(plugin.name), t);

      assert.equal(plugin.calls, 1);
    });

    test('a follow-up that throws a NonRetryableError is reported once as a process warning and not retried', async (t) => {
      class CorruptStateError extends NonRetryableError {
        override readonly name = 'CorruptStateError';
      }
      await using resources = new AsyncDisposableStack();
      const { storage, boss } = await open(resources);
      const plugin = availability('non-retryable', async () => {
        throw new CorruptStateError('state of "non-retryable-chat" is corrupt');
      });
      await using host = await new AgentRuntime(
        plainAgent([plugin]),
      ).initialize(defineStack(async () => ({ storage })));
      const conversation = { chatId: 'non-retryable-chat', userId: 'u1' };

      const warnings = await recordingWarnings(
        '"non-retryable-chat" is corrupt',
        async (warnings) => {
          await host.work();
          await Array.fromAsync(
            (await host.enqueue(conversation, userTurn('t-1', 'hello'))).stream,
          );
          await waitFor(() => assert.equal(plugin.calls, 1), {
            signal: t.signal,
          });
          await settled(boss, settleQueue(plugin.name), t);
          return warnings;
        },
      );

      assert.deepStrictEqual(
        { calls: plugin.calls, warnings },
        {
          calls: 1,
          warnings: [
            'Settle follow-up "non-retryable" failed and will not be retried: state of "non-retryable-chat" is corrupt',
          ],
        },
      );
    });

    test('a turn whose settle intent write fails is completed again by its orphan reconciliation, which records the intent, and the follow-up runs', async (t) => {
      await using resources = new AsyncDisposableStack();
      const storage = new FailFirstSettleWriteStorage(
        (await open(resources)).storage,
      );
      const plugin = availability('write-failure', async () => {});
      await using host = await new AgentRuntime(
        plainAgent([plugin]),
      ).initialize(defineStack(async () => ({ storage })));
      await host.work();
      const conversation = { chatId: 'write-failure', userId: 'u1' };

      const turn = await host.enqueue(conversation, userTurn('t-1', 'hello'));
      await Array.fromAsync(turn.stream);

      await waitFor(() => assert.equal(plugin.calls, 1), { signal: t.signal });
      assert.deepStrictEqual(
        {
          failedWrites: storage.failedWrites,
          status: (await host.observe(conversation).status(turn.id))?.status,
        },
        { failedWrites: 1, status: 'completed' },
      );
    });

    test('cancelling a queued turn resolves though its availability follow-up fails, and the follow-up is retried', async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage } = await open(resources);
      const plugin = availability('cancel', async (call) => {
        if (call === 1) throw new Error('first availability attempt fails');
      });
      const release = new Latch();
      await using host = await new AgentRuntime(
        plainAgent([plugin], answering(release.wait())),
      ).initialize(defineStack(async () => ({ storage })));
      await host.work();
      const conversation = { chatId: 'cancelled', userId: 'u1' };
      const running = await host.enqueue(conversation, userTurn('t-1', 'held'));
      const queued = await host.enqueue(conversation, userTurn('t-2', 'later'));
      await waitFor(
        async () =>
          assert.equal(
            (await host.observe(conversation).status(running.id))?.status,
            'running',
          ),
        { signal: t.signal },
      );

      await host.observe(conversation).cancel(queued.id);
      // The running turn holds its chat, so only the cancel's intent runs:
      // its first attempt fails, and its retry succeeds.
      await waitFor(() => assert.equal(plugin.calls, 2), { signal: t.signal });
      release.open();
      await Array.fromAsync(running.stream);

      assert.equal(
        (await host.observe(conversation).status(queued.id))?.status,
        'cancelled',
      );
    });
  });

  suite(`scheduling wakes on the real queue (${name})`, () => {
    test('a cron occurrence whose wake delivery fails is delivered again by pg-boss, later than its due time, and the occurrence dispatches with its successor armed', async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage, boss } = await open(resources);
      // One minute before the latest noon that real time has passed: the
      // occurrence is not due by the plugin's clock, so the chat's settle
      // dispatches nothing, while pg-boss delivers its wake at once.
      const noon = new Date();
      noon.setUTCHours(12, 0, 0, 0);
      if (noon.getTime() > Date.now()) noon.setUTCDate(noon.getUTCDate() - 1);
      const clock = { Date: { now: () => noon.getTime() - 60_000 } };
      const plugin = conversationScheduling();
      const conversation = { chatId: 'redelivered', userId: 'u1' };
      const seen: string[] = [];
      const root = plainAgent(
        [plugin],
        new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            if (prompt.at(-1)?.role === 'tool') return textResult('created');
            const text = lastUserText(prompt);
            seen.push(text);
            return text === 'create cron'
              ? toolCallResult({
                  toolCallId: crypto.randomUUID(),
                  toolName: 'CronCreate',
                  input: JSON.stringify({
                    cron: '0 12 * * *',
                    prompt: 'daily',
                  }),
                })
              : textResult(`done:${text}`);
          },
        }),
      );
      // Takes no wake, so the occurrence is first delivered to the next host,
      // with the chat idle.
      const creating = await schedulingHost(
        root,
        plugin,
        storage,
        new ScheduleOnlyScheduler(await schedulingQueue(boss)),
        clock,
      );
      await creating.work();
      await Array.fromAsync(
        (await creating.enqueue(conversation, userTurn('t-1', 'create cron')))
          .stream,
      );
      await creating[Symbol.asyncDispose]();

      // Its first delivery fails as it arms the successor.
      const scheduler = new FailingScheduler(await schedulingQueue(boss), 1);
      await using next = await schedulingHost(
        root,
        plugin,
        storage,
        scheduler,
        clock,
      );
      await next.work();

      await waitFor(() => assert.ok(seen.includes('daily')), {
        signal: t.signal,
      });
      assert.deepStrictEqual(
        { seen, failing: scheduler.failing },
        { seen: ['create cron', 'daily'], failing: 0 },
      );
    });
  });
}
