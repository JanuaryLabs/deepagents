import { TemporaryFiles } from '@zukhruf/fs';
import { describe, test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { DockerTestbed } from '@zukhruf/testing/docker';
import { Postgres, type PostgresDatabase } from '@zukhruf/testing/postgres';
import { type UIMessage, type UIMessageChunk, isToolUIPart } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';

import {
  DockerSandboxEnvironment,
  type SandboxContext,
  type StoppableSandboxEnvironment,
} from '@deepagents/context';
import {
  type AdmissionScope,
  type AgentHost,
  AgentRuntime,
  AgentStorage,
  type AgentTree,
  EmbeddedAgentStorage,
  MessageDeliveryModes,
  PostgresAgentStorage,
  type SandboxIdleWake,
  type Wake,
  WakeScheduler,
  createInterAgentCommunication,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { uploads } from '@deepagents/experimental/zukhruf/uploads';

import {
  textResult,
  toolCallResult,
} from '../../testing/stream-results.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const testbed = new DockerTestbed({ environment: process.env });
const defaults = await testbed.defaults();
const testPostgres = new Postgres({ environment: process.env });

/** The idle wakes' queue, named after the storages' default turn queue. */
const IDLE_QUEUE = 'zukhruf-turns-sandbox-idle';

const conversation = { chatId: 'chat', userId: 'owner' };

/** The uploads plugin's directory, and the chat's scope in it. */
const UPLOADS = '/workspace/uploads';
const uploadScope = {
  userId: conversation.userId,
  sessionId: conversation.chatId,
};

/** One worker process's storage on the database, with its own pool and pg-boss. */
async function postgresStorage(
  resources: AsyncDisposableStack,
  database: PostgresDatabase,
) {
  const boss = new PgBoss({ connectionString: database.connectionString });
  boss.on('error', () => {});
  await boss.start();
  resources.defer(() => boss.stop({ graceful: false }));
  const storage = resources.use(
    await PostgresAgentStorage.create({ pool: database.pool(), boss }),
  );
  return { storage, boss };
}

/** A storage and the pg-boss its turn queue and idle wakes run on. */
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
    open: async (resources: AsyncDisposableStack) =>
      postgresStorage(resources, resources.use(await testPostgres.database())),
  },
] satisfies {
  name: string;
  open(
    resources: AsyncDisposableStack,
  ): Promise<{ storage: AgentStorage; boss: PgBoss }>;
}[];

/** A chat environment of its own namespace, as one worker process builds it. */
function chatEnvironment(namespace: string) {
  return new DockerSandboxEnvironment({ namespace, container: defaults });
}

/** A turn's command, which the model calls for only once `after` settles. */
interface HeldCommand {
  command: string;
  after: Promise<unknown>;
}

/** Runs the next of `commands` in the chat's container on each turn, then answers. */
function bashEachTurn(...commands: (string | HeldCommand)[]) {
  const pending = [...commands];
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      if (prompt.at(-1)?.role === 'tool') return textResult('done');
      const next = pending.shift();
      assert.ok(next, 'the test scripts a command for every turn');
      const command = typeof next === 'string' ? next : next.command;
      if (typeof next !== 'string') await next.after;
      return toolCallResult({
        toolCallId: crypto.randomUUID(),
        toolName: 'bash',
        input: JSON.stringify({ command, reasoning: 'the scripted command' }),
      });
    },
  });
}

/** The bash tool's settled output in a turn's stream. */
async function bashOutput(turn: { stream: ReadableStream<UIMessageChunk> }) {
  for (const chunk of await Array.fromAsync(turn.stream)) {
    if (chunk.type === 'tool-output-available') {
      return { type: chunk.type, output: chunk.output, errorText: undefined };
    }
    if (chunk.type === 'tool-output-error') {
      return {
        type: chunk.type,
        output: undefined,
        errorText: chunk.errorText,
      };
    }
  }
  return undefined;
}

const bashSucceeded = (stdout: string) => ({
  type: 'tool-output-available',
  output: { stdout, stderr: '', exitCode: 0 },
  errorText: undefined,
});

/** The containers of the namespace, or of one chat in it, by their labels. */
async function namespaceContainers(namespace: string, chatId?: string) {
  const client = await testbed.client();
  return client.containers.list({
    all: true,
    filters: {
      label: [
        `deepagents.sandbox.namespace=${namespace}`,
        ...(chatId === undefined ? [] : [`deepagents.sandbox.chat=${chatId}`]),
      ],
    },
  });
}

/** The one container of the chat in the namespace, found by its labels. */
async function chatContainer(namespace: string, chatId = conversation.chatId) {
  const [summary, ...others] = await namespaceContainers(namespace, chatId);
  assert.ok(summary?.Id, 'the chat has a container');
  assert.deepStrictEqual(others, [], 'the chat has one container');
  const found = await (await testbed.client()).containers.find(summary.Id);
  assert.ok(found, `container ${summary.Id} exists`);
  return found;
}

/** Removes every container of the test's namespace, by its label. */
async function removeNamespace(namespace: string): Promise<void> {
  const client = await testbed.client();
  for (const { Id } of await namespaceContainers(namespace)) {
    if (Id === undefined) continue;
    const container = await client.containers.find(Id);
    // Unpausing a running container fails with Docker's generic 500, so the
    // container's own state decides.
    if ((await container?.inspect())?.State?.Paused) await container?.unpause();
    await container?.remove({ force: true });
  }
}

async function containerStatus(namespace: string) {
  return (await (await chatContainer(namespace)).inspect()).State?.Status;
}

async function idleJobStates(boss: PgBoss) {
  return (await boss.findJobs(IDLE_QUEUE)).map(({ state }) => state);
}

/** Every state the idle queue's jobs are seen in while the test waits `ms`. */
async function idleJobStatesDuring(boss: PgBoss, ms: number, t: TestContext) {
  const seen = new Set<string>();
  let waited = false;
  const watching = waitFor(
    async () => {
      for (const state of await idleJobStates(boss)) seen.add(state);
      assert.ok(waited, 'the test is still waiting');
    },
    { signal: t.signal },
  );
  await setTimeout(ms, undefined, { signal: t.signal });
  waited = true;
  await watching;
  return [...seen];
}

/** The idle stop due for the chat's latest settled turn, once it is armed. */
async function armedStop(boss: PgBoss, t: TestContext) {
  return waitFor(
    async () => {
      const [job, ...others] = await boss.findJobs<SandboxIdleWake>(IDLE_QUEUE);
      assert.deepStrictEqual(
        { state: job?.state, others },
        { state: 'created', others: [] },
      );
      return job;
    },
    { signal: t.signal },
  );
}

/** Approves every tool call the chat's head waits on, as a client answers it. */
async function approveHead(host: AgentHost) {
  const head = (await host.observe(conversation).engine.getMessages()).at(-1);
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
  return host.enqueue(conversation, { message, trigger: 'submit-message' });
}

/** Real idle wakes that refuse their first schedule, as an unreachable queue would. */
class FailOnceWakes extends WakeScheduler<SandboxIdleWake> {
  failedSchedules = 0;
  readonly #inner: WakeScheduler<SandboxIdleWake>;

  constructor(inner: WakeScheduler<SandboxIdleWake>) {
    super();
    this.#inner = inner;
  }

  override async schedule(wake: Wake<SandboxIdleWake>) {
    if (this.failedSchedules === 0) {
      this.failedSchedules++;
      throw new Error('idle wake queue unreachable');
    }
    await this.#inner.schedule(wake);
  }

  override cancel(id: string) {
    return this.#inner.cancel(id);
  }

  override consume(handler: (wake: Wake<SandboxIdleWake>) => Promise<void>) {
    return this.#inner.consume(handler);
  }
}

/** A real storage whose idle wakes refuse their first schedule. */
class FailOnceIdleWakesStorage extends AgentStorage {
  readonly sandboxIdleWakes: FailOnceWakes;
  readonly #inner: AgentStorage;

  constructor(inner: AgentStorage) {
    super();
    this.#inner = inner;
    this.sandboxIdleWakes = new FailOnceWakes(inner.sandboxIdleWakes);
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
    return this.#inner.admit(tree, work);
  }
}

/** A real chat environment whose first stop fails, as an engine that is briefly unreachable does. */
class FailOnceStopEnvironment implements StoppableSandboxEnvironment {
  failedStops = 0;
  readonly #inner: StoppableSandboxEnvironment;

  constructor(inner: StoppableSandboxEnvironment) {
    this.#inner = inner;
  }

  open(chat: SandboxContext) {
    return this.#inner.open(chat);
  }

  delete(chat: SandboxContext) {
    return this.#inner.delete(chat);
  }

  async stop(chat: SandboxContext) {
    if (this.failedStops === 0) {
      this.failedStops++;
      throw new Error('docker engine unreachable');
    }
    await this.#inner.stop(chat);
  }
}

void describe.each(storages, ({ name, open }) =>
  describe(name, () => {
    test(`${name}: a chat's container keeps running for idleTimeoutMs after the chat goes idle, then stops, and the next turn runs in it, started again with its files`, async (t) => {
      const namespace = `idle-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const root = defineAgent({
          name: 'root',
          model: bashEachTurn(
            'echo kept > note.txt && hostname',
            'cat note.txt && hostname',
          ),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 4_000,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        const first = await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        const settledAt = Date.now();
        const container = await chatContainer(namespace);
        const afterTurn = await containerStatus(namespace);
        // The stop is due idleTimeoutMs after the turn finished, which is no
        // later than its stream closing here: so at most that long from now,
        // and later than now.
        const dueAfterSettled =
          (await armedStop(boss, t)).startAfter.getTime() - settledAt;
        await waitFor(
          async () => assert.equal(await containerStatus(namespace), 'exited'),
          { signal: t.signal },
        );
        const second = await bashOutput(
          await host.enqueue(conversation, userTurn('turn-2', 'second')),
        );

        const hostname = `${container.id.slice(0, 12)}\n`;
        assert.deepStrictEqual(
          {
            afterTurn,
            dueAfterIdleTime: dueAfterSettled > 0 && dueAfterSettled <= 4_000,
            turns: [first, second],
            container: (await chatContainer(namespace)).id,
          },
          {
            afterTurn: 'running',
            dueAfterIdleTime: true,
            turns: [
              bashSucceeded(hostname),
              bashSucceeded(`kept\n${hostname}`),
            ],
            container: container.id,
          },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    test(`${name}: a stop due for a chat's earlier turn, delivered once a later turn has settled, leaves its container running, and the later turn's own window stops it`, async (t) => {
      const namespace = `later-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const root = defineAgent({
          name: 'root',
          // The later turn runs a while, so its own stop falls due well
          // after the earlier one is delivered.
          model: bashEachTurn('hostname', 'sleep 6 && hostname'),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 10_000,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        // Held back until the later turn settles, as a slow or repeated
        // delivery of the earlier turn's stop would arrive.
        const earlier = await armedStop(boss, t);
        await storage.sandboxIdleWakes.cancel(earlier.id);
        await bashOutput(
          await host.enqueue(conversation, userTurn('turn-2', 'second')),
        );
        const pending = async () =>
          (await boss.findJobs(IDLE_QUEUE))
            .map(({ id, state }) => ({ earlier: id === earlier.id, state }))
            .toSorted(
              (left, right) => Number(right.earlier) - Number(left.earlier),
            );
        await waitFor(
          async () =>
            assert.deepStrictEqual(await pending(), [
              { earlier: true, state: 'cancelled' },
              { earlier: false, state: 'created' },
            ]),
          { signal: t.signal },
        );
        await storage.sandboxIdleWakes.schedule({
          id: earlier.id,
          runAt: earlier.startAfter,
          data: earlier.data,
        });
        await waitFor(
          async () =>
            assert.deepStrictEqual(await pending(), [
              { earlier: false, state: 'created' },
            ]),
          { signal: t.signal },
        );
        const afterEarlier = await containerStatus(namespace);
        const laterOnceLooked = await pending();
        await waitFor(
          async () => assert.equal(await containerStatus(namespace), 'exited'),
          { signal: t.signal },
        );

        assert.deepStrictEqual(
          { afterEarlier, laterOnceLooked },
          {
            afterEarlier: 'running',
            laterOnceLooked: [{ earlier: false, state: 'created' }],
          },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    test(`${name}: a stop that falls due while the chat's next turn waits in the queue leaves its container running`, async (t) => {
      const namespace = `queued-${crypto.randomUUID()}`;
      const other = { chatId: 'other', userId: 'owner' };
      const release = Promise.withResolvers<void>();
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const root = defineAgent({
          name: 'root',
          // The turns run one at a time, in this order: the chat's first,
          // the other chat's, held until the test releases it, then the
          // chat's second.
          model: bashEachTurn(
            'echo first',
            { command: 'echo other', after: release.promise },
            'echo second',
          ),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 15_000,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work({ concurrency: 1 });

        await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        const { id: due } = await armedStop(boss, t);
        const blocking = await host.enqueue(
          other,
          userTurn('other-1', 'other'),
        );
        const queued = await host.enqueue(
          conversation,
          userTurn('turn-2', 'second'),
        );
        const dueOnceQueued = (await boss.findJobs(IDLE_QUEUE)).find(
          ({ id }) => id === due,
        )?.state;
        await waitFor(
          async () =>
            assert.deepStrictEqual(
              (await boss.findJobs(IDLE_QUEUE))
                .filter(({ id }) => id === due)
                .map(({ state }) => state),
              [],
            ),
          { signal: t.signal },
        );
        const whileQueued = {
          container: await containerStatus(namespace),
          chat: (await host.observe(conversation).conversationStatus()).type,
        };
        release.resolve();
        const [blocked, second] = await Promise.all([
          bashOutput(blocking),
          bashOutput(queued),
        ]);

        assert.deepStrictEqual(
          { dueOnceQueued, whileQueued, blocked, second },
          {
            dueOnceQueued: 'created',
            whileQueued: { container: 'running', chat: 'active' },
            blocked: bashSucceeded('other\n'),
            second: bashSucceeded('second\n'),
          },
        );
      } finally {
        release.resolve();
        await removeNamespace(namespace);
      }
    });

    test(`${name}: a chat waiting on an approval keeps its container running past idleTimeoutMs with no stop due, and stops once the approved continuation ends`, async (t) => {
      const namespace = `approval-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const root = defineAgent({
          name: 'root',
          model: bashEachTurn('hostname'),
          instructions: [],
          toolApproval: { bash: 'user-approval' },
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 1_000,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        const paused = await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        const jobs = await idleJobStatesDuring(boss, 3_000, t);
        const waiting = {
          status: await containerStatus(namespace),
          jobs,
          head: (await host.observe(conversation).conversationStatus()).type,
        };
        const continued = await bashOutput(await approveHead(host));
        await waitFor(
          async () => assert.equal(await containerStatus(namespace), 'exited'),
          { signal: t.signal },
        );

        const container = await chatContainer(namespace);
        assert.deepStrictEqual(
          { paused, waiting, continued },
          {
            paused: undefined,
            waiting: { status: 'running', jobs: [], head: 'active' },
            continued: bashSucceeded(`${container.id.slice(0, 12)}\n`),
          },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    test(`${name}: a chat whose container was removed by hand before its idle stop was due settles that stop without a failure or retry, and its next turn runs in a new container`, async (t) => {
      const namespace = `removed-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const root = defineAgent({
          name: 'root',
          model: bashEachTurn('hostname', 'hostname'),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 10_000,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        const removed = await chatContainer(namespace);
        const removedWhile = (await removed.inspect()).State?.Status;
        await removed.remove({ force: true });
        // Still due after the removal, so the stop meets a missing container.
        const { state: dueOnceRemoved } = await armedStop(boss, t);
        const seen = new Set<string>();
        await waitFor(
          async () => {
            const states = await idleJobStates(boss);
            for (const state of states) seen.add(state);
            assert.deepStrictEqual(states, []);
          },
          { signal: t.signal, interval: 20 },
        );
        const second = await bashOutput(
          await host.enqueue(conversation, userTurn('turn-2', 'second')),
        );

        const replacement = await chatContainer(namespace);
        assert.deepStrictEqual(
          {
            removedWhile,
            dueOnceRemoved,
            failedOrRetried: [...seen].filter(
              (state) => state === 'retry' || state === 'failed',
            ),
            second,
            replaced: replacement.id !== removed.id,
          },
          {
            removedWhile: 'running',
            dueOnceRemoved: 'created',
            failedOrRetried: [],
            second: bashSucceeded(`${replacement.id.slice(0, 12)}\n`),
            replaced: true,
          },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    test(`${name}: a chat's next turn cancels the stop due for its earlier turn, its container keeps running through that turn past the earlier stop's due time, and stops once the later turn has been idle for idleTimeoutMs`, async (t) => {
      const namespace = `cancel-${crypto.randomUUID()}`;
      const looked = Promise.withResolvers<void>();
      const stopWatching = new AbortController();
      let watching: Promise<void> | undefined;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const root = defineAgent({
          name: 'root',
          // The later turn runs its command once the earlier stop's due time
          // has passed, so the turn runs past it.
          model: bashEachTurn('hostname', {
            command: 'hostname',
            after: looked.promise,
          }),
          instructions: [],
          // Long enough that the later turn is queued well before the earlier
          // stop is due: an enqueue on the remote Postgres took 5.5 s.
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 20_000,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        const earlier = await armedStop(boss, t);
        const later = await host.enqueue(
          conversation,
          userTurn('turn-2', 'second'),
        );
        const statuses = new Set<string | undefined>();
        let laterEnded = false;
        watching = waitFor(
          async () => {
            statuses.add(await containerStatus(namespace));
            assert.ok(laterEnded, 'the later turn is still running');
          },
          { signal: AbortSignal.any([t.signal, stopWatching.signal]) },
        );
        // Settles once the earlier stop leaves 'created': cancelled by the
        // later turn, or, without the cancel, delivered at its due time.
        const earlierWhileLaterRuns = await waitFor(
          async () => {
            const [job] = await boss.findJobs(IDLE_QUEUE, { id: earlier.id });
            assert.notEqual(job?.state, 'created');
            return job?.state;
          },
          { signal: t.signal },
        );
        await setTimeout(
          Math.max(0, earlier.startAfter.getTime() - Date.now()) + 1_000,
          undefined,
          { signal: t.signal },
        );
        looked.resolve();
        const second = await bashOutput(later);
        const settledAt = Date.now();
        laterEnded = true;
        await watching;
        const laterStop = await waitFor(
          async () => {
            const job = (await boss.findJobs(IDLE_QUEUE)).find(
              ({ id }) => id !== earlier.id,
            );
            assert.equal(job?.state, 'created');
            return job;
          },
          { signal: t.signal },
        );
        await waitFor(
          async () => assert.equal(await containerStatus(namespace), 'exited'),
          { signal: t.signal },
        );

        const container = await chatContainer(namespace);
        const dueAfterSettled = laterStop.startAfter.getTime() - settledAt;
        assert.deepStrictEqual(
          {
            earlierWhileLaterRuns,
            whileLaterRuns: [...statuses],
            second,
            laterDueAfterIdleTime:
              dueAfterSettled > 0 && dueAfterSettled <= 20_000,
          },
          {
            earlierWhileLaterRuns: 'cancelled',
            whileLaterRuns: ['running'],
            second: bashSucceeded(`${container.id.slice(0, 12)}\n`),
            laterDueAfterIdleTime: true,
          },
        );
      } finally {
        looked.resolve();
        stopWatching.abort();
        await watching?.catch(() => undefined);
        await removeNamespace(namespace);
      }
    });

    test(`${name}: with idleTimeoutMs 0, a chat's next turn sent once the earlier turn's stop is armed runs to its end, and from then on the container stops exactly once`, async (t) => {
      const namespace = `stale-${crypto.randomUUID()}`;
      const events = new AbortController();
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const root = defineAgent({
          name: 'root',
          // The later turn runs long enough for the die events to be watched
          // before it ends.
          model: bashEachTurn('hostname', 'sleep 3 && hostname'),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 0,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        const first = await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        // The earlier stop is armed: still due, or already delivered.
        await waitFor(
          async () => {
            if ((await idleJobStates(boss)).length > 0) return;
            assert.equal(await containerStatus(namespace), 'exited');
          },
          { signal: t.signal, interval: 10 },
        );
        const later = await host.enqueue(
          conversation,
          userTurn('turn-2', 'second'),
        );
        // Subscribed once the later turn is queued, so a stop the earlier
        // wake made before that (the chat was idle then) is not counted.
        const dies: { timeNano?: number }[] = [];
        const client = await testbed.client();
        const watching = (async () => {
          try {
            for await (const event of client.events({
              filters: {
                type: ['container'],
                event: ['die'],
                label: [`deepagents.sandbox.namespace=${namespace}`],
              },
              signal: events.signal,
            })) {
              dies.push(event);
            }
          } catch (error) {
            if (!events.signal.aborted) throw error;
          }
        })();
        const second = await bashOutput(later);
        // Exited, and the die event of that exit has arrived: events come in
        // order, so every earlier die has arrived too.
        await waitFor(
          async () => {
            const state = (await (await chatContainer(namespace)).inspect())
              .State;
            assert.equal(state?.Status, 'exited');
            const finishedAt = Date.parse(state?.FinishedAt ?? '') * 1e6;
            assert.ok(dies.some(({ timeNano = 0 }) => timeNano >= finishedAt));
          },
          { signal: t.signal },
        );
        events.abort();
        await watching;

        const hostname = `${(await chatContainer(namespace)).id.slice(0, 12)}\n`;
        assert.deepStrictEqual(
          { first, second, dies: dies.length },
          {
            first: bashSucceeded(hostname),
            second: bashSucceeded(hostname),
            dies: 1,
          },
        );
      } finally {
        events.abort();
        await removeNamespace(namespace);
      }
    });

    test(`${name}: a plugin's upload to a chat with no turn starts its container, which stops idleTimeoutMs after the upload, and the chat's first turn runs in it, started again, with the uploaded file`, async (t) => {
      const namespace = `borrow-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const uploaded = uploads({ directory: UPLOADS });
        const root = defineAgent({
          name: 'root',
          model: bashEachTurn(
            `cat ${UPLOADS}/${uploadScope.userId}/${uploadScope.sessionId}/* && hostname`,
          ),
          instructions: [],
          // Long enough that the stop is seen due before it is delivered.
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 10_000,
          }),
          plugins: [uploaded],
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        const uploading = Date.now();
        await host.plugin(uploaded).write(uploadScope, {
          data: new TextEncoder().encode('uploaded\n'),
          mediaType: 'image/png',
        });
        const upload = Date.now();
        const afterUpload = await containerStatus(namespace);
        const container = await chatContainer(namespace);
        const due = (await armedStop(boss, t)).startAfter.getTime();
        await waitFor(
          async () => assert.equal(await containerStatus(namespace), 'exited'),
          { signal: t.signal },
        );
        const first = await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );

        assert.deepStrictEqual(
          {
            afterUpload,
            dueAfterUpload: due >= uploading + 10_000 && due <= upload + 10_000,
            first,
            container: (await chatContainer(namespace)).id,
          },
          {
            afterUpload: 'running',
            dueAfterUpload: true,
            first: bashSucceeded(`uploaded\n${container.id.slice(0, 12)}\n`),
            container: container.id,
          },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    test(`${name}: a plugin's upload to an idle chat moves its stop to idleTimeoutMs after the upload, so its container keeps running past the stop due for the chat's last turn and stops once the upload has been idle that long`, async (t) => {
      const namespace = `reborrow-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const uploadsPlugin = uploads({ directory: UPLOADS });
        const root = defineAgent({
          name: 'root',
          model: bashEachTurn('hostname'),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 30_000,
          }),
          plugins: [uploadsPlugin],
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        const settled = await armedStop(boss, t);
        // A third of the way through the settled turn's window.
        await setTimeout(
          Math.max(0, settled.startAfter.getTime() - 20_000 - Date.now()),
          undefined,
          { signal: t.signal },
        );
        const uploading = Date.now();
        await host.plugin(uploadsPlugin).write(uploadScope, {
          data: new TextEncoder().encode('uploaded\n'),
          mediaType: 'image/png',
        });
        const upload = Date.now();
        await setTimeout(
          Math.max(0, settled.startAfter.getTime() - Date.now()) + 1_000,
          undefined,
          { signal: t.signal },
        );
        // Cancelled, or delivered by now, the stop having run.
        const settledStop = await waitFor(
          async () => {
            const [job] = await boss.findJobs(IDLE_QUEUE, { id: settled.id });
            assert.ok(job?.state !== 'created' && job?.state !== 'active');
            return job?.state;
          },
          { signal: t.signal },
        );
        const pastSettledStop = {
          settledStop,
          container: await containerStatus(namespace),
        };
        const uploadStop = (
          await boss.findJobs<SandboxIdleWake>(IDLE_QUEUE)
        ).find(({ id }) => id !== settled.id);
        await waitFor(
          async () => assert.equal(await containerStatus(namespace), 'exited'),
          { signal: t.signal },
        );
        const stopped = Date.now();

        const due = uploadStop?.startAfter.getTime() ?? 0;
        assert.deepStrictEqual(
          {
            pastSettledStop,
            uploadStop: {
              state: uploadStop?.state,
              turnId: uploadStop?.data.turnId,
              dueAfterUpload:
                due >= uploading + 30_000 && due <= upload + 30_000,
            },
            stoppedAfterUploadWindow: stopped >= uploading + 30_000,
          },
          {
            pastSettledStop: { settledStop: 'cancelled', container: 'running' },
            uploadStop: {
              state: 'created',
              turnId: settled.data.turnId,
              dueAfterUpload: true,
            },
            stoppedAfterUploadWindow: true,
          },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    test(`${name}: a plugin's upload while the chat's turn runs arms no stop of its own, so the one stop due is the turn's, idleTimeoutMs after it ends`, async (t) => {
      const namespace = `busy-${crypto.randomUUID()}`;
      const running = Promise.withResolvers<void>();
      const uploaded = Promise.withResolvers<void>();
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const uploadsPlugin = uploads({ directory: UPLOADS });
        const root = defineAgent({
          name: 'root',
          // The turn answers only once the upload it runs during has ended.
          model: new MockLanguageModelV4({
            doStream: async () => {
              running.resolve();
              await uploaded.promise;
              return textResult('done');
            },
          }),
          instructions: [],
          // Long enough that no stop is delivered while the test reads them.
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 20_000,
          }),
          plugins: [uploadsPlugin],
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        const turn = await host.enqueue(
          conversation,
          userTurn('turn-1', 'first'),
        );
        await running.promise;
        const { fileId } = await host.plugin(uploadsPlugin).write(uploadScope, {
          data: new TextEncoder().encode('uploaded\n'),
          mediaType: 'image/png',
        });
        // Read back before the turn answers, so the upload is in the chat's
        // sandbox while the turn still runs.
        const duringTurn = {
          upload: await host.plugin(uploadsPlugin).read(uploadScope, fileId),
          chat: (await host.observe(conversation).conversationStatus()).type,
        };
        const upload = Date.now();
        uploaded.resolve();
        await Array.fromAsync(turn.stream);
        // The turn's own stop: due idleTimeoutMs after the turn ended, which
        // is after the upload ended.
        const afterTurn = (startAfter: Date) =>
          startAfter.getTime() > upload + 20_000;
        await waitFor(
          async () =>
            assert.ok(
              (await boss.findJobs(IDLE_QUEUE)).some(({ startAfter }) =>
                afterTurn(startAfter),
              ),
            ),
          { signal: t.signal },
        );

        assert.deepStrictEqual(
          {
            duringTurn,
            stops: (await boss.findJobs(IDLE_QUEUE)).map(
              ({ state, startAfter }) => ({
                state,
                afterTurn: afterTurn(startAfter),
              }),
            ),
          },
          {
            duringTurn: {
              upload: {
                data: new TextEncoder().encode('uploaded\n'),
                mediaType: 'image/png',
              },
              chat: 'active',
            },
            stops: [{ state: 'created', afterTurn: true }],
          },
        );
      } finally {
        running.resolve();
        uploaded.resolve();
        await removeNamespace(namespace);
      }
    });

    test(`${name}: a chat whose sandbox declares idleTimeoutMs false keeps its container running after it goes idle, with no stop armed`, async (t) => {
      const namespace = `never-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const root = defineAgent({
          name: 'root',
          model: bashEachTurn('hostname'),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: false,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );

        assert.deepStrictEqual(
          {
            seen: await idleJobStatesDuring(boss, 3_000, t),
            status: await containerStatus(namespace),
          },
          { seen: [], status: 'running' },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    test(`${name}: an idle stop whose arming fails once is armed again by its retried settle intent, and the container stops`, async (t) => {
      const namespace = `retried-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage } = await open(resources);
        const flaky = new FailOnceIdleWakesStorage(storage);
        const root = defineAgent({
          name: 'root',
          model: bashEachTurn('hostname'),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 1_000,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage: flaky })),
        );
        await host.work();

        await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );

        await waitFor(
          async () => assert.equal(await containerStatus(namespace), 'exited'),
          { signal: t.signal },
        );
        assert.equal(flaky.sandboxIdleWakes.failedSchedules, 1);
      } finally {
        await removeNamespace(namespace);
      }
    });

    test(`${name}: archiving an idle chat stops its container at once, long before its idleTimeoutMs, and cancels the stop its last turn armed; unarchiving starts nothing, and the next turn runs in that same container, started again with its files`, async (t) => {
      const namespace = `archive-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const root = defineAgent({
          name: 'root',
          model: bashEachTurn(
            'echo kept > note.txt && hostname',
            'cat note.txt && hostname',
          ),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 600_000,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        const first = await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        const container = await chatContainer(namespace);
        const idleStop = await armedStop(boss, t);

        await host.archiveSession(conversation);
        await waitFor(
          async () => assert.equal(await containerStatus(namespace), 'exited'),
          { signal: t.signal },
        );
        // The archive's own stop is deleted once delivered.
        const leftOnQueue = await waitFor(
          async () => {
            const jobs = (await boss.findJobs(IDLE_QUEUE)).map(
              ({ id, state }) => ({ lastTurns: id === idleStop.id, state }),
            );
            assert.deepStrictEqual(jobs, [
              { lastTurns: true, state: 'cancelled' },
            ]);
            return jobs;
          },
          { signal: t.signal },
        );
        await host.unarchiveSession(conversation);
        const afterUnarchive = await containerStatus(namespace);
        const second = await bashOutput(
          await host.enqueue(conversation, userTurn('turn-2', 'second')),
        );

        const hostname = `${container.id.slice(0, 12)}\n`;
        assert.deepStrictEqual(
          {
            leftOnQueue,
            afterUnarchive,
            turns: [first, second],
            container: (await chatContainer(namespace)).id,
          },
          {
            leftOnQueue: [{ lastTurns: true, state: 'cancelled' }],
            afterUnarchive: 'exited',
            turns: [
              bashSucceeded(hostname),
              bashSucceeded(`kept\n${hostname}`),
            ],
            container: container.id,
          },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    test(`${name}: archiving a chat while its turn runs cancels the turn and stops its container, leaving no stop armed`, async (t) => {
      const namespace = `archive-running-${crypto.randomUUID()}`;
      const holding = Promise.withResolvers<void>();
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        let calls = 0;
        // The second turn's model call runs until the archive aborts it.
        const model = new MockLanguageModelV4({
          doStream: async ({ prompt, abortSignal }) => {
            if (prompt.at(-1)?.role === 'tool') return textResult('done');
            calls += 1;
            if (calls === 1) {
              return toolCallResult({
                toolCallId: crypto.randomUUID(),
                toolName: 'bash',
                input: JSON.stringify({
                  command: 'hostname',
                  reasoning: 'start',
                }),
              });
            }
            holding.resolve();
            return new Promise<never>((_resolve, reject) => {
              abortSignal?.addEventListener(
                'abort',
                () => reject(abortSignal.reason),
                { once: true },
              );
            });
          },
        });
        const root = defineAgent({
          name: 'root',
          model,
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: 600_000,
          }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        const firstStop = await armedStop(boss, t);
        const running = await host.enqueue(
          conversation,
          userTurn('turn-2', 'second'),
        );
        await holding.promise;

        await host.archiveSession(conversation);
        await Array.fromAsync(running.stream);
        await waitFor(
          async () => assert.equal(await containerStatus(namespace), 'exited'),
          { signal: t.signal },
        );
        // The second turn cancelled the first's stop as it started; every
        // other stop is deleted once delivered.
        const leftOnQueue = await waitFor(
          async () => {
            const jobs = (await boss.findJobs(IDLE_QUEUE)).map(
              ({ id, state }) => ({ firstTurns: id === firstStop.id, state }),
            );
            assert.deepStrictEqual(jobs, [
              { firstTurns: true, state: 'cancelled' },
            ]);
            return jobs;
          },
          { signal: t.signal },
        );

        assert.deepStrictEqual(
          {
            turn: (await host.observe(conversation).status(running.id))?.status,
            leftOnQueue,
          },
          {
            turn: 'cancelled',
            leftOnQueue: [{ firstTurns: true, state: 'cancelled' }],
          },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    test(`${name}: a sub-agent of an archived session that collaboration runs again starts its container for that turn and stops it as soon as the turn ends, though its idleTimeoutMs is far off`, async (t) => {
      const rootNamespace = `archive-root-${crypto.randomUUID()}`;
      const childNamespace = `archive-child-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const rootSteps = [
          toolCallResult({
            toolCallId: 'spawn',
            toolName: 'spawn_agent',
            input: JSON.stringify({
              task_name: 'worker',
              agent_type: 'worker',
              message: 'start',
              fork_turns: 'none',
            }),
          }),
        ];
        const root = defineAgent({
          name: 'root',
          model: new MockLanguageModelV4({
            doStream: async () => rootSteps.shift() ?? textResult('done'),
          }),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(rootNamespace), {
            idleTimeoutMs: 600_000,
          }),
          subagents: [
            defineAgent({
              name: 'worker',
              model: bashEachTurn('hostname', 'hostname'),
              instructions: [],
              sandbox: defineSandbox(chatEnvironment(childNamespace), {
                idleTimeoutMs: 600_000,
              }),
            }),
          ],
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work({ concurrency: 2 });

        await Array.fromAsync(
          (await host.enqueue(conversation, userTurn('turn-1', 'delegate')))
            .stream,
        );
        const child = await waitFor(
          async () => {
            const [session] = await host.listHistory(conversation.userId);
            const [worker] = session?.children ?? [];
            assert.equal(worker?.state, 'completed');
            assert.ok(worker);
            const found = {
              chatId: worker.chatId,
              userId: conversation.userId,
            };
            assert.equal(await storage.queue.getTurnActivity(found), 'idle');
            return found;
          },
          { signal: t.signal },
        );
        const childStatus = async () =>
          (await (await chatContainer(childNamespace, child.chatId)).inspect())
            .State;

        await host.archiveSession(conversation);
        // The archive's stops are delivered and deleted; the cancelled ones,
        // its turns' idle stops, stay.
        await waitFor(
          async () => {
            assert.equal((await childStatus())?.Status, 'exited');
            assert.ok(!(await idleJobStates(boss)).includes('created'));
          },
          { signal: t.signal },
        );
        const stoppedByArchive = await childStatus();
        await host.deliver(
          createInterAgentCommunication({
            author: conversation,
            recipient: child,
            content: 'run again',
          }),
          MessageDeliveryModes.TriggerTurn,
        );
        await waitFor(
          async () => {
            const state = await childStatus();
            assert.notEqual(state?.StartedAt, stoppedByArchive?.StartedAt);
            assert.equal(state?.Status, 'exited');
          },
          { signal: t.signal },
        );

        assert.deepStrictEqual(
          {
            leftArmed: (await idleJobStates(boss)).includes('created'),
            archived: (
              await host.listHistory(conversation.userId, { archived: true })
            ).map(({ chatId }) => chatId),
          },
          { leftArmed: false, archived: [conversation.chatId] },
        );
      } finally {
        await removeNamespace(rootNamespace);
        await removeNamespace(childNamespace);
      }
    });

    test(`${name}: archiving a chat whose sandbox declares idleTimeoutMs false stops its container too, and a stop that fails is delivered again until the container has exited, the session archived throughout`, async (t) => {
      const namespace = `archive-retry-${crypto.randomUUID()}`;
      try {
        await using resources = new AsyncDisposableStack();
        const { storage, boss } = await open(resources);
        const environment = new FailOnceStopEnvironment(
          chatEnvironment(namespace),
        );
        const root = defineAgent({
          name: 'root',
          model: bashEachTurn('hostname'),
          instructions: [],
          sandbox: defineSandbox(environment, { idleTimeoutMs: false }),
        });
        await using host = await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        );
        await host.work();

        await bashOutput(
          await host.enqueue(conversation, userTurn('turn-1', 'first')),
        );
        await host.archiveSession(conversation);
        await waitFor(
          async () => assert.equal(await containerStatus(namespace), 'exited'),
          { signal: t.signal },
        );
        await waitFor(
          async () => assert.deepStrictEqual(await idleJobStates(boss), []),
          { signal: t.signal },
        );

        assert.deepStrictEqual(
          {
            failedStops: environment.failedStops,
            archived: (
              await host.listHistory(conversation.userId, { archived: true })
            ).map(({ chatId }) => chatId),
          },
          { failedStops: 1, archived: [conversation.chatId] },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });
  }),
);

test("postgres: a chat's idle stop, delivered by a worker that never ran its turn, stops its container, and the next turn on the worker that ran the first runs in that same container, started again", async (t) => {
  const namespace = `workers-${crypto.randomUUID()}`;
  try {
    await using resources = new AsyncDisposableStack();
    const database = resources.use(await testPostgres.database());
    // Two worker processes on one database, each with its own pool, pg-boss,
    // environment and held sandboxes.
    const workerHost = async (model: MockLanguageModelV4) => {
      const { storage, boss } = await postgresStorage(resources, database);
      const root = defineAgent({
        name: 'root',
        model,
        instructions: [],
        // Long enough that the turn's worker stops working before it is due.
        sandbox: defineSandbox(chatEnvironment(namespace), {
          idleTimeoutMs: 10_000,
        }),
      });
      const host = resources.use(
        await new AgentRuntime(root).initialize(
          defineStack(async () => ({ storage })),
        ),
      );
      return { host, boss };
    };
    const a = await workerHost(bashEachTurn('hostname', 'hostname'));
    const b = await workerHost(bashEachTurn());

    const aWorking = await a.host.work();
    const first = await bashOutput(
      await a.host.enqueue(conversation, userTurn('turn-1', 'first')),
    );
    const container = await chatContainer(namespace);
    const stop = await armedStop(a.boss, t);
    await aWorking[Symbol.asyncDispose]();
    await setTimeout(
      Math.max(0, stop.startAfter.getTime() - Date.now()) + 1_000,
      undefined,
      { signal: t.signal },
    );
    const dueWithNoWorker = {
      container: await containerStatus(namespace),
      stop: (await a.boss.findJobs(IDLE_QUEUE, { id: stop.id })).map(
        ({ state }) => state,
      ),
    };
    const bWorking = await b.host.work();
    await waitFor(
      async () => assert.deepStrictEqual(await idleJobStates(a.boss), []),
      { signal: t.signal },
    );
    const stoppedByB = (await namespaceContainers(namespace)).map(
      ({ Id, State }) => ({ Id, State }),
    );
    await bWorking[Symbol.asyncDispose]();
    await a.host.work();
    const second = await bashOutput(
      await a.host.enqueue(conversation, userTurn('turn-2', 'second')),
    );

    const hostname = `${container.id.slice(0, 12)}\n`;
    assert.deepStrictEqual(
      {
        first,
        dueWithNoWorker,
        stoppedByB,
        second,
        container: (await chatContainer(namespace)).id,
      },
      {
        first: bashSucceeded(hostname),
        dueWithNoWorker: { container: 'running', stop: ['created'] },
        stoppedByB: [{ Id: container.id, State: 'exited' }],
        second: bashSucceeded(hostname),
        container: container.id,
      },
    );
  } finally {
    await removeNamespace(namespace);
  }
});

test("postgres: a child agent whose turn ends while its parent waits in wait_agent stops its own container after its idleTimeoutMs, while the parent's keeps running through the parent's turn, which stops its own once it has been idle that long", async (t) => {
  const rootNamespace = `parent-${crypto.randomUUID()}`;
  const childNamespace = `child-${crypto.randomUUID()}`;
  const answer = Promise.withResolvers<void>();
  try {
    await using resources = new AsyncDisposableStack();
    const { storage, boss } = await postgresStorage(
      resources,
      resources.use(await testPostgres.database()),
    );
    let rootCalls = 0;
    let waited: { prompt: string; at: number } | undefined;
    // Spawns the child and waits for it, then answers only once the test
    // has looked at both containers.
    const rootModel = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        rootCalls += 1;
        if (rootCalls === 1) {
          return toolCallResult({
            toolCallId: 'spawn',
            toolName: 'spawn_agent',
            input: JSON.stringify({
              task_name: 'research',
              agent_type: 'worker',
              message: 'Find the answer',
              fork_turns: 'none',
            }),
          });
        }
        if (rootCalls === 2) {
          return toolCallResult({
            toolCallId: 'wait',
            toolName: 'wait_agent',
            input: JSON.stringify({ timeout_ms: 60_000 }),
          });
        }
        waited ??= { prompt: JSON.stringify(prompt), at: Date.now() };
        await answer.promise;
        return textResult('root done');
      },
    });
    const root = defineAgent({
      name: 'root',
      model: rootModel,
      instructions: [],
      sandbox: defineSandbox(chatEnvironment(rootNamespace), {
        idleTimeoutMs: 3_000,
      }),
      subagents: [
        defineAgent({
          name: 'worker',
          model: bashEachTurn('hostname'),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(childNamespace), {
            idleTimeoutMs: 3_000,
          }),
        }),
      ],
    });
    await using host = await new AgentRuntime(root).initialize(
      defineStack(async () => ({ storage })),
    );
    await host.work({ concurrency: 2 });

    const turn = await host.enqueue(
      conversation,
      userTurn('turn-1', 'Research it'),
    );
    // The child's: the parent's turn has not settled, so arms none.
    const childStop = await armedStop(boss, t);
    await waitFor(
      async () => assert.deepStrictEqual(await idleJobStates(boss), []),
      { signal: t.signal },
    );
    const soleStatus = async (namespace: string) =>
      (await namespaceContainers(namespace)).map(({ State }) => State);
    const childStopped = {
      child: await soleStatus(childNamespace),
      parent: await soleStatus(rootNamespace),
      parentChat: (await host.observe(conversation).conversationStatus()).type,
      waitedForChild: waited?.prompt.includes('"timed_out":false'),
    };
    // The child's turn ended before the wait returned, so its stop is due
    // at most idleTimeoutMs after that, and later than it.
    const childDueAfterWait =
      childStop.startAfter.getTime() - (waited?.at ?? Infinity);
    answer.resolve();
    await Array.fromAsync(turn.stream);
    const settledAt = Date.now();
    const parentDueAfterSettled =
      (await armedStop(boss, t)).startAfter.getTime() - settledAt;
    await waitFor(
      async () =>
        assert.deepStrictEqual(await soleStatus(rootNamespace), ['exited']),
      { signal: t.signal },
    );

    assert.deepStrictEqual(
      {
        childStop: childStop.data.conversation.chatId !== conversation.chatId,
        childDueAfterIdleTime:
          childDueAfterWait > 0 && childDueAfterWait <= 3_000,
        childStopped,
        parentDueAfterIdleTime:
          parentDueAfterSettled > 0 && parentDueAfterSettled <= 3_000,
      },
      {
        childStop: true,
        childDueAfterIdleTime: true,
        childStopped: {
          child: ['exited'],
          parent: ['running'],
          parentChat: 'active',
          waitedForChild: true,
        },
        parentDueAfterIdleTime: true,
      },
    );
  } finally {
    answer.resolve();
    await removeNamespace(rootNamespace);
    await removeNamespace(childNamespace);
  }
});
