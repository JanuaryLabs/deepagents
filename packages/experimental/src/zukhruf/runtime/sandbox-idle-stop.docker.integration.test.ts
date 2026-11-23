import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { DockerTestbed } from '@zukhruf/testing/docker';
import { Postgres } from '@zukhruf/testing/postgres';
import { type UIMessage, type UIMessageChunk, isToolUIPart } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { PgBoss } from 'pg-boss';

import { DockerSandboxEnvironment } from '@deepagents/context';
import {
  type AgentHost,
  AgentRuntime,
  type AgentStorage,
  EmbeddedAgentStorage,
  PostgresAgentStorage,
  type SandboxIdleWake,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';

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
    open: async (resources: AsyncDisposableStack) => {
      const database = resources.use(await testPostgres.database());
      const boss = new PgBoss({ connectionString: database.connectionString });
      boss.on('error', () => {});
      await boss.start();
      resources.defer(() => boss.stop({ graceful: false }));
      const storage = resources.use(
        await PostgresAgentStorage.create({ pool: database.pool(), boss }),
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
    await container?.unpause().catch(() => undefined);
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

for (const { name, open } of storages) {
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
          turns: [bashSucceeded(hostname), bashSucceeded(`kept\n${hostname}`)],
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
      const blocking = await host.enqueue(other, userTurn('other-1', 'other'));
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

  test(`${name}: a chat whose sandbox declares idleTimeoutMs false keeps its container running after it goes idle, with no stop due and no worker taking the idle queue's wakes`, async (t) => {
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
      // Any wake on the idle queue, which a worker taking it would settle.
      const runAt = new Date();
      await storage.sandboxIdleWakes.schedule({
        id: crypto.randomUUID(),
        runAt,
        data: { conversation, turnId: null, scheduledFor: runAt.getTime() },
      });
      await setTimeout(3_000, undefined, { signal: t.signal });

      assert.deepStrictEqual(
        {
          status: await containerStatus(namespace),
          jobs: await idleJobStates(boss),
        },
        { status: 'running', jobs: ['created'] },
      );
    } finally {
      await removeNamespace(namespace);
    }
  });
}
