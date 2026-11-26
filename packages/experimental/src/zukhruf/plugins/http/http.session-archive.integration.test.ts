import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import { describe, test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type Db, PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import { VirtualSandboxEnvironment } from '@deepagents/context';
import {
  type AdmissionScope,
  type AgentDeclaration,
  type AgentHost,
  AgentRuntime,
  type AgentStack,
  AgentStorage,
  type AgentTree,
  EmbeddedAgentStorage,
  MessageDeliveryModes,
  PgBossWakeScheduler,
  PostgresAgentStorage,
  TurnQueue,
  type TurnRef,
  createInterAgentCommunication,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import {
  type SchedulingWake,
  conversationScheduling,
  conversationSchedulingCapabilities,
} from '@deepagents/experimental/zukhruf/conversation-scheduling';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';
import {
  type ScheduledTaskTransaction,
  schedules,
  schedulesCapabilities,
} from '@deepagents/experimental/zukhruf/schedules';

import {
  textResult,
  toolCallResult,
} from '../../../testing/stream-results.fixture.ts';

const MOUNT = '/zukhruf/v1';

const testPostgres = new Postgres({ environment: process.env });

const acceptedBodySchema = z.looseObject({ turnId: z.string() });
const historyItemSchema = z.looseObject({
  chatId: z.string(),
  userId: z.string(),
  messageCount: z.number(),
  archivedAt: z.number().optional(),
  status: z.looseObject({ type: z.string() }),
  children: z.array(
    z.looseObject({ chatId: z.string(), path: z.string(), state: z.string() }),
  ),
});
const historySchema = z.array(historyItemSchema);
const sessionSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      role: z.string(),
      parts: z.array(z.looseObject({ type: z.string() })),
    }),
  ),
});
const archivedAtSchema = z.looseObject({
  zukhruf: z.looseObject({ archivedAt: z.number().optional() }),
});
const cronStateSchema = z.looseObject({
  zukhruf: z.looseObject({
    scheduling: z.looseObject({
      cron: z.record(
        z.string(),
        z.looseObject({ generation: z.number(), nextRunAt: z.number() }),
      ),
      dispatching: z.unknown().optional(),
    }),
  }),
});

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
      const transaction: ScheduledTaskTransaction = (operation) =>
        storage.queueDatabase.transaction((tx) => operation(fromPglite(tx)));
      return { storage, boss: storage.boss, transaction };
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
      const pool = database.pool();
      const storage = resources.use(
        await PostgresAgentStorage.create({
          pool,
          boss,
          queue: { pollingIntervalSeconds: 0.5 },
        }),
      );
      const transaction: ScheduledTaskTransaction = async (operation) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const db: Db = {
            executeSql: (text, values) => client.query(text, values),
          };
          const result = await operation(db);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      return { storage, boss, transaction };
    },
  },
] satisfies {
  name: string;
  open(resources: AsyncDisposableStack): Promise<{
    storage: AgentStorage;
    boss: PgBoss;
    transaction: ScheduledTaskTransaction;
  }>;
}[];

/**
 * The real turn queue, except that the first park of a delivery runs
 * `beforeFirstPark` to completion before it reaches the real park, and
 * records which turn parked.
 */
class InterposedParkQueue extends TurnQueue {
  beforeFirstPark: () => Promise<void> = async () => {};
  readonly parked: string[] = [];
  readonly #inner: TurnQueue;

  constructor(inner: TurnQueue) {
    super();
    this.#inner = inner;
  }

  override push(turn: TurnRef) {
    return this.#inner.push(turn);
  }

  override getTurnActivity(conversation: Pick<TurnRef, 'chatId' | 'userId'>) {
    return this.#inner.getTurnActivity(conversation);
  }

  override getCurrentTurn(conversation: Pick<TurnRef, 'chatId' | 'userId'>) {
    return this.#inner.getCurrentTurn(conversation);
  }

  override cancel(streamId: string) {
    return this.#inner.cancel(streamId);
  }

  override consume(...[handler, options]: Parameters<TurnQueue['consume']>) {
    return this.#inner.consume(
      (turn, context) =>
        handler(turn, {
          ...context,
          park: async () => {
            if (this.parked.length === 0) {
              this.parked.push(turn.streamId);
              await this.beforeFirstPark();
            }
            await context.park();
          },
        }),
      options,
    );
  }

  override resumeParked(chatId: string) {
    return this.#inner.resumeParked(chatId);
  }

  override forget(conversation: Pick<TurnRef, 'chatId' | 'userId'>) {
    return this.#inner.forget(conversation);
  }

  override isLost(streamId: string, queuedSince: number) {
    return this.#inner.isLost(streamId, queuedSince);
  }
}

/** A real storage whose turn queue is an InterposedParkQueue over its own. */
class InterposedParkStorage extends AgentStorage {
  readonly queue: InterposedParkQueue;
  readonly #inner: AgentStorage;

  constructor(inner: AgentStorage) {
    super();
    this.#inner = inner;
    this.queue = new InterposedParkQueue(inner.queue);
  }

  get store() {
    return this.#inner.store;
  }

  get streams() {
    return this.#inner.streams;
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
    return this.#inner.admit(tree, work);
  }
}

/** A runtime of `agent` on the stack's parts, served as http(runtime) for user-1. */
async function serveAgent(
  resources: AsyncDisposableStack,
  stack: Awaited<ReturnType<AgentStack>>,
  agent: Pick<
    AgentDeclaration,
    'name' | 'model' | 'sandbox' | 'subagents' | 'plugins'
  >,
) {
  const runtime = resources.use(
    await new AgentRuntime(
      defineAgent({ instructions: [], ...agent }),
    ).initialize(defineStack(async () => stack)),
  );
  const app = new Hono<HttpEnv>();
  app.use(`${MOUNT}/*`, (context, next) => {
    context.set('userId', context.req.header('x-user-id') ?? 'user-1');
    return next();
  });
  app.route(MOUNT, http(runtime));
  return { app, runtime };
}

function postTurn(app: Hono<HttpEnv>, sessionId: string, text = 'Hello') {
  return app.request(`${MOUNT}/session/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: {
        id: `message-${randomUUID()}`,
        role: 'user',
        parts: [{ type: 'text', text }],
      },
      trigger: 'submit-message',
    }),
  });
}

async function startTurn(app: Hono<HttpEnv>, sessionId: string, text?: string) {
  const response = await postTurn(app, sessionId, text);
  assert.equal(response.status, 202);
  return acceptedBodySchema.parse(await response.json()).turnId;
}

/** Waits until the turn's stream reads `status`. */
function turnStatus(
  runtime: AgentHost,
  conversation: { chatId: string; userId: string },
  turnId: string,
  status: string,
  signal: AbortSignal,
) {
  return waitFor(
    async () =>
      assert.equal(
        (await runtime.observe(conversation).status(turnId))?.status,
        status,
      ),
    { signal },
  );
}

function archive(app: Hono<HttpEnv>, sessionId: string, userId = 'user-1') {
  return app.request(`${MOUNT}/session/${sessionId}/archive`, {
    method: 'POST',
    headers: { 'x-user-id': userId },
  });
}

function unarchive(app: Hono<HttpEnv>, sessionId: string, userId = 'user-1') {
  return app.request(`${MOUNT}/session/${sessionId}/unarchive`, {
    method: 'POST',
    headers: { 'x-user-id': userId },
  });
}

async function answer(response: Response) {
  const text = await response.text();
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: text === '' ? null : JSON.parse(text),
  };
}

async function historyIds(app: Hono<HttpEnv>, query = '') {
  return historySchema
    .parse(await (await app.request(`${MOUNT}/history${query}`)).json())
    .map(({ chatId }) => chatId);
}

/** The text of each user message of the session, in order. */
async function userTexts(app: Hono<HttpEnv>, sessionId: string) {
  const { messages } = sessionSchema.parse(
    await (await app.request(`${MOUNT}/session/${sessionId}`)).json(),
  );
  return messages
    .filter(({ role }) => role === 'user')
    .map(({ parts }) =>
      parts.map((part) => (part.type === 'text' ? part.text : '')).join(''),
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
 * Answers a model call with `done:<text>` for the last user text, except a
 * call whose text is `hold`: it calls `onHold` and runs until it is aborted.
 */
function answerOrHold(
  {
    prompt,
    abortSignal,
  }: { prompt: LanguageModelV4Prompt; abortSignal?: AbortSignal },
  onHold: () => void = () => {},
) {
  const text = lastUserText(prompt);
  if (text !== 'hold') return Promise.resolve(textResult(`done:${text}`));
  onHold();
  return new Promise<never>((_resolve, reject) => {
    abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), {
      once: true,
    });
  });
}

function holdingModel() {
  return new MockLanguageModelV4({
    doStream: (options) => answerOrHold(options),
  });
}

/** The root's tool call that spawns the worker sub-agent at /root/worker. */
function spawnWorker() {
  return toolCallResult({
    toolCallId: randomUUID(),
    toolName: 'spawn_agent',
    input: JSON.stringify({
      task_name: 'worker',
      agent_type: 'worker',
      message: 'start',
      fork_turns: 'none',
    }),
  });
}

/** The worker's conversation, once the session and its worker are idle with nothing queued. */
function idleChild(
  app: Hono<HttpEnv>,
  storage: AgentStorage,
  sessionId: string,
  signal: AbortSignal,
) {
  const root = { chatId: sessionId, userId: 'user-1' };
  return waitFor(
    async () => {
      const history = historySchema.parse(
        await (await app.request(`${MOUNT}/history`)).json(),
      );
      const session = history.find(({ chatId }) => chatId === sessionId);
      const found = session?.children.find(
        ({ path }) => path === '/root/worker',
      );
      assert.deepStrictEqual(
        { session: session?.status.type, worker: found?.state },
        { session: 'idle', worker: 'completed' },
      );
      assert.ok(found);
      const child = { chatId: found.chatId, userId: 'user-1' };
      for (const member of [root, child]) {
        assert.equal(await storage.queue.getTurnActivity(member), 'idle');
      }
      return child;
    },
    { signal },
  );
}

/** The stored archivedAt of the chat, or undefined. */
async function storedArchivedAt(storage: AgentStorage, chatId: string) {
  return archivedAtSchema.parse((await storage.store.getChat(chatId))?.metadata)
    .zukhruf.archivedAt;
}

/** The owner events of a GET /events response, one per SSE data frame, until the stream ends. */
async function* ownerEvents(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  assert.ok(response.body);
  let buffered = '';
  for await (const chunk of response.body.pipeThrough(
    new TextDecoderStream(),
  )) {
    buffered += chunk;
    const frames = buffered.split('\n\n');
    buffered = frames.pop() ?? '';
    for (const frame of frames) {
      if (frame.startsWith('data: ')) {
        yield z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(frame.slice('data: '.length)));
      }
    }
  }
}

/** The next `count` lifecycle changes of the owner events, sorted by id. */
async function nextLifecycle(
  events: AsyncGenerator<Record<string, unknown>>,
  count: number,
) {
  const lifecycle: Record<string, unknown>[] = [];
  while (lifecycle.length < count) {
    const { value, done } = await events.next();
    assert.ok(!done);
    if (value.lifecycle !== undefined) lifecycle.push(value);
  }
  return lifecycle.toSorted((left, right) =>
    String(left.id).localeCompare(String(right.id)),
  );
}

/** Resolves once every job of the queue is done: pg-boss deletes a job its worker completed. */
function drained(boss: PgBoss, queue: string, signal: AbortSignal) {
  return waitFor(
    async () => {
      const jobs = await boss.findJobs(queue);
      assert.deepStrictEqual(jobs, []);
      return jobs;
    },
    { signal },
  );
}

function sessionArchived(sessionId: string) {
  return {
    status: 409,
    cacheControl: 'no-store',
    body: {
      error: 'Session is archived',
      cause: {
        code: 'zukhruf/session-archived',
        detail: `Session ${sessionId} is archived; unarchive it first`,
      },
    },
  };
}

const archived = { status: 204, cacheControl: 'no-store', body: null };

/** Codex's `<turn_aborted>` marker, recorded after a turn the archive interrupts. */
const TURN_ABORTED =
  '<turn_aborted>\nThe previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>';

void describe.each(storages, ({ name, open }) =>
  describe(name, () => {
    test(`${name}: POST /session/:sessionId/archive hides the session from GET /history and lists it under ?archived=true while GET /session still reads it, refuses its turns and a second archive with 409 session-archived; POST /session/:sessionId/unarchive answers 200 with its history item, puts it back in GET /history and admits turns again, and a second unarchive answers 409 session-not-archived`, async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage } = await open(resources);
      const { app, runtime } = await serveAgent(
        resources,
        { storage },
        {
          name: 'root',
          model: holdingModel(),
          sandbox: defineSandbox(new VirtualSandboxEnvironment()),
        },
      );
      resources.use(await runtime.work());
      const sessionId = randomUUID();
      const unknownId = randomUUID();
      const root = { chatId: sessionId, userId: 'user-1' };
      await turnStatus(
        runtime,
        root,
        await startTurn(app, sessionId),
        'completed',
        t.signal,
      );

      const unknown = await answer(await archive(app, unknownId));
      const otherUser = (await archive(app, sessionId, 'user-2')).status;
      const first = await answer(await archive(app, sessionId));
      const hidden = await historyIds(app);
      const listedArchived = historySchema.parse(
        await (await app.request(`${MOUNT}/history?archived=true`)).json(),
      );
      const listedUnarchived = await historyIds(app, '?archived=false');
      const invalidFilter = (
        await app.request(`${MOUNT}/history?archived=maybe`)
      ).status;
      const read = (await app.request(`${MOUNT}/session/${sessionId}`)).status;
      const turn = await answer(await postTurn(app, sessionId));
      const second = await answer(await archive(app, sessionId));
      const otherUserUnarchive = (await unarchive(app, sessionId, 'user-2'))
        .status;
      const otherUserArchived = historySchema
        .parse(
          await (
            await app.request(`${MOUNT}/history?archived=true`, {
              headers: { 'x-user-id': 'user-2' },
            })
          ).json(),
        )
        .map(({ chatId }) => chatId);
      const restored = await answer(await unarchive(app, sessionId));
      const back = await historyIds(app);
      const nextTurn = (await postTurn(app, sessionId)).status;
      const again = await answer(await unarchive(app, sessionId));
      const item = historyItemSchema.parse(restored.body);

      assert.deepStrictEqual(
        {
          unknown: unknown.status,
          otherUser,
          otherUserUnarchive,
          otherUserArchived,
          first,
          hidden,
          listedArchived: listedArchived.map(({ chatId, archivedAt }) => ({
            chatId,
            archived: typeof archivedAt === 'number',
          })),
          listedUnarchived,
          invalidFilter,
          read,
          turn,
          second,
          restored: {
            status: restored.status,
            cacheControl: restored.cacheControl,
            item: {
              ...item,
              createdAt: typeof item.createdAt,
              updatedAt: typeof item.updatedAt,
            },
          },
          back,
          nextTurn,
          again,
        },
        {
          unknown: 404,
          otherUser: 404,
          otherUserUnarchive: 404,
          otherUserArchived: [],
          first: archived,
          hidden: [],
          listedArchived: [{ chatId: sessionId, archived: true }],
          listedUnarchived: [],
          invalidFilter: 400,
          read: 200,
          turn: sessionArchived(sessionId),
          second: sessionArchived(sessionId),
          restored: {
            status: 200,
            cacheControl: 'no-store',
            item: {
              chatId: sessionId,
              userId: 'user-1',
              title: 'Hello',
              createdAt: 'number',
              updatedAt: 'number',
              messageCount: 2,
              status: { type: 'idle' },
              children: [],
            },
          },
          back: [sessionId],
          nextTurn: 202,
          again: {
            status: 409,
            cacheControl: 'no-store',
            body: {
              error: 'Session is not archived',
              cause: {
                code: 'zukhruf/session-not-archived',
                detail: `Session ${sessionId} is not archived`,
              },
            },
          },
        },
      );
    });

    test(`${name}: archiving a session cancels its running turn and keeps the turn queued behind it, which does not run while the session is archived and runs with its user message once it is unarchived`, async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage, boss } = await open(resources);
      const { app, runtime } = await serveAgent(
        resources,
        { storage },
        {
          name: 'root',
          model: holdingModel(),
          sandbox: defineSandbox(new VirtualSandboxEnvironment()),
        },
      );
      resources.use(await runtime.work());
      const sessionId = randomUUID();
      const root = { chatId: sessionId, userId: 'user-1' };
      const running = await startTurn(app, sessionId, 'hold');
      await turnStatus(runtime, root, running, 'running', t.signal);
      const queued = await startTurn(app, sessionId, 'queued behind');

      const response = await answer(await archive(app, sessionId));
      await turnStatus(runtime, root, running, 'cancelled', t.signal);
      // The queued turn's job is held, not deleted, while the session is
      // archived. Waiting for that hold is what makes the turn's 'queued'
      // status below mean it was kept from running, not that no worker had
      // claimed it yet.
      const held = await waitFor(
        async () => {
          const states = (
            await boss.findJobs('zukhruf-turns', { key: sessionId })
          ).map(({ state }) => state);
          assert.deepStrictEqual(states, ['cancelled']);
          return states;
        },
        { signal: t.signal },
      );
      const whileArchived = (await runtime.observe(root).status(queued))
        ?.status;
      const restored = (await unarchive(app, sessionId)).status;
      await turnStatus(runtime, root, queued, 'completed', t.signal);

      assert.deepStrictEqual(
        {
          response,
          held,
          whileArchived,
          restored,
          userTexts: await userTexts(app, sessionId),
        },
        {
          response: archived,
          held: ['cancelled'],
          whileArchived: 'queued',
          restored: 200,
          userTexts: ['hold', TURN_ABORTED, 'queued behind'],
        },
      );
    });

    test(`${name}: a turn queued before the archive runs once the session is unarchived even when the unarchive lands while a worker is parking it`, async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage: real } = await open(resources);
      const storage = new InterposedParkStorage(real);
      const model = holdingModel();
      const { app, runtime } = await serveAgent(
        resources,
        { storage },
        {
          name: 'root',
          model,
          sandbox: defineSandbox(new VirtualSandboxEnvironment()),
        },
      );
      const sessionId = randomUUID();
      let unarchived: number | undefined;
      storage.queue.beforeFirstPark = async () => {
        unarchived = (await unarchive(app, sessionId)).status;
      };
      resources.use(await runtime.work());
      const root = { chatId: sessionId, userId: 'user-1' };
      const running = await startTurn(app, sessionId, 'hold');
      await turnStatus(runtime, root, running, 'running', t.signal);
      const queued = await startTurn(app, sessionId, 'queued behind');

      const response = await answer(await archive(app, sessionId));
      await turnStatus(runtime, root, queued, 'completed', t.signal);

      assert.deepStrictEqual(
        {
          response,
          parked: storage.queue.parked,
          unarchived,
          lastPrompt: lastUserText(model.doStreamCalls.at(-1)?.prompt ?? []),
          userTexts: await userTexts(app, sessionId),
        },
        {
          response: archived,
          parked: [queued],
          unarchived: 200,
          lastPrompt: 'queued behind',
          userTexts: ['hold', TURN_ABORTED, 'queued behind'],
        },
      );
    });

    test(`${name}: archiving a session also cancels its sub-agent's running turn and keeps the sub-agent's turn queued behind it, which runs once the session is unarchived`, async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage, boss } = await open(resources);
      const sandbox = defineSandbox(new VirtualSandboxEnvironment());
      const rootSteps = [spawnWorker()];
      let workerCalls = 0;
      let aborted = false;
      const { app, runtime } = await serveAgent(
        resources,
        { storage },
        {
          name: 'root',
          model: new MockLanguageModelV4({
            doStream: async () => rootSteps.shift() ?? textResult('done'),
          }),
          sandbox,
          subagents: [
            defineAgent({
              name: 'worker',
              instructions: [],
              sandbox,
              model: new MockLanguageModelV4({
                doStream: async ({ abortSignal }) => {
                  workerCalls += 1;
                  // The worker's second turn, woken by mail, runs until aborted.
                  if (workerCalls !== 2) return textResult('worker done');
                  return new Promise<never>((_resolve, reject) => {
                    abortSignal?.addEventListener(
                      'abort',
                      () => {
                        aborted = true;
                        reject(abortSignal.reason);
                      },
                      { once: true },
                    );
                  });
                },
              }),
            }),
          ],
        },
      );
      resources.use(await runtime.work({ concurrency: 2 }));
      const sessionId = randomUUID();
      const root = { chatId: sessionId, userId: 'user-1' };
      await startTurn(app, sessionId);
      const child = await idleChild(app, storage, sessionId, t.signal);
      await runtime.deliver(
        createInterAgentCommunication({
          author: root,
          recipient: child,
          content: 'run until stopped',
        }),
        MessageDeliveryModes.TriggerTurn,
      );
      await waitFor(
        async () =>
          assert.equal(
            (await runtime.observe(child).status())?.status,
            'running',
          ),
        { signal: t.signal },
      );
      const queued = await runtime.enqueue(child, {
        message: {
          id: `message-${randomUUID()}`,
          role: 'user',
          parts: [{ type: 'text', text: 'queued for worker' }],
        },
        trigger: 'submit-message',
      });

      const response = await answer(await archive(app, sessionId));
      // As for the session's own queued turn: the hold is what makes the
      // 'queued' status below mean the turn was kept from running.
      const held = await waitFor(
        async () => {
          const states = (
            await boss.findJobs('zukhruf-turns', { key: child.chatId })
          ).map(({ state }) => state);
          assert.deepStrictEqual(states, ['cancelled']);
          return states;
        },
        { signal: t.signal },
      );
      const whileArchived = (await runtime.observe(child).status(queued.id))
        ?.status;
      const callsWhileArchived = workerCalls;
      const restored = (await unarchive(app, sessionId)).status;
      await turnStatus(runtime, child, queued.id, 'completed', t.signal);

      assert.deepStrictEqual(
        {
          response,
          aborted,
          held,
          whileArchived,
          callsWhileArchived,
          restored,
          callsAfter: workerCalls,
        },
        {
          response: archived,
          aborted: true,
          held: ['cancelled'],
          whileArchived: 'queued',
          callsWhileArchived: 2,
          restored: 200,
          callsAfter: 3,
        },
      );
    });

    test(`${name}: a sub-agent of an archived session still runs a turn when mail is delivered to it, staying archived, while the session stays hidden from GET /history`, async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage } = await open(resources);
      const sandbox = defineSandbox(new VirtualSandboxEnvironment());
      const rootSteps = [spawnWorker()];
      let workerTurns = 0;
      const { app, runtime } = await serveAgent(
        resources,
        { storage },
        {
          name: 'root',
          model: new MockLanguageModelV4({
            doStream: async () => rootSteps.shift() ?? textResult('done'),
          }),
          sandbox,
          subagents: [
            defineAgent({
              name: 'worker',
              instructions: [],
              sandbox,
              model: new MockLanguageModelV4({
                doStream: async () => {
                  workerTurns += 1;
                  return textResult('worker done');
                },
              }),
            }),
          ],
        },
      );
      resources.use(await runtime.work({ concurrency: 2 }));
      const sessionId = randomUUID();
      const root = { chatId: sessionId, userId: 'user-1' };
      await startTurn(app, sessionId);
      const child = await idleChild(app, storage, sessionId, t.signal);
      const childArchive = (await archive(app, child.chatId)).status;
      const response = await answer(await archive(app, sessionId));
      // Read from storage: no public surface lists a sub-agent's archive mark.
      const childArchivedAt = await storedArchivedAt(storage, child.chatId);

      await runtime.deliver(
        createInterAgentCommunication({
          author: root,
          recipient: child,
          content: 'run again',
        }),
        MessageDeliveryModes.TriggerTurn,
      );
      const turns = await waitFor(
        async () => {
          assert.equal(workerTurns, 2);
          assert.equal(await storage.queue.getTurnActivity(child), 'idle');
          assert.equal(
            (await runtime.observe(child).status())?.status,
            'completed',
          );
          return workerTurns;
        },
        { signal: t.signal },
      );

      assert.deepStrictEqual(
        {
          childArchive,
          response,
          archivedBefore: typeof childArchivedAt,
          turns,
          archivedAfter: await storedArchivedAt(storage, child.chatId),
          history: await historyIds(app),
          archivedHistory: await historyIds(app, '?archived=true'),
        },
        {
          childArchive: 404,
          response: archived,
          archivedBefore: 'number',
          turns: 2,
          archivedAfter: childArchivedAt,
          history: [],
          archivedHistory: [sessionId],
        },
      );
    });

    test(`${name}: GET /events tells the owner that the session and its sub-agent's chat were archived, then unarchived, with one lifecycle change for each`, async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage } = await open(resources);
      const sandbox = defineSandbox(new VirtualSandboxEnvironment());
      const rootSteps = [spawnWorker()];
      const { app, runtime } = await serveAgent(
        resources,
        { storage },
        {
          name: 'root',
          model: new MockLanguageModelV4({
            doStream: async () => rootSteps.shift() ?? textResult('done'),
          }),
          sandbox,
          subagents: [
            defineAgent({
              name: 'worker',
              instructions: [],
              sandbox,
              model: new MockLanguageModelV4({
                doStream: async () => textResult('worker done'),
              }),
            }),
          ],
        },
      );
      resources.use(await runtime.work({ concurrency: 2 }));
      const sessionId = randomUUID();
      await startTurn(app, sessionId);
      const child = await idleChild(app, storage, sessionId, t.signal);
      // The stream ends when the test's limit aborts it.
      const events = ownerEvents(
        await app.request(`${MOUNT}/events`, { signal: t.signal }),
      );
      const ready = (await events.next()).value;

      const archiveResponse = (await archive(app, sessionId)).status;
      const archivedEvents = await nextLifecycle(events, 2);
      const unarchiveResponse = (await unarchive(app, sessionId)).status;
      const unarchivedEvents = await nextLifecycle(events, 2);

      const change = (id: string, lifecycle: string) => ({
        type: 'change',
        resource: 'conversation',
        id,
        lifecycle,
      });
      const both = (lifecycle: string) =>
        [
          change(sessionId, lifecycle),
          change(child.chatId, lifecycle),
        ].toSorted((left, right) => left.id.localeCompare(right.id));
      assert.deepStrictEqual(
        {
          ready,
          archiveResponse,
          archivedEvents,
          unarchiveResponse,
          unarchivedEvents,
        },
        {
          ready: { type: 'ready' },
          archiveResponse: 204,
          archivedEvents: both('archived'),
          unarchiveResponse: 200,
          unarchivedEvents: both('unarchived'),
        },
      );
    });

    test(`${name}: an archived session runs nothing on its own: a schedules run that targets it fails with the session archived, and a cron occurrence of it that falls due is skipped while its availability follow-up finishes without a retry and the cron is kept; once unarchived, the next schedules run and the cron's next occurrence run in it`, async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage, boss, transaction } = await open(resources);
      const scheduled = schedules({
        queue: `scheduled-${randomUUID()}`,
        reconciliationIntervalMs: 50,
      });
      const wakes = new PgBossWakeScheduler<SchedulingWake>(boss, {
        queue: `scheduling-${randomUUID()}`,
        pollingIntervalSeconds: 0.5,
      });
      await wakes.initialize();
      // Years ahead of real time, so no wake comes due on its own: each
      // occurrence falls due only when the test moves this clock past it.
      let now = Date.parse('2030-01-01T00:00:00Z');
      const clock = { Date: { now: () => now } };
      let modelCalls = 0;
      const { app, runtime } = await serveAgent(
        resources,
        {
          storage,
          bindings: [
            schedulesCapabilities.boss.bind(boss),
            schedulesCapabilities.transaction.bind(transaction),
            conversationSchedulingCapabilities.scheduler.bind(wakes),
            conversationSchedulingCapabilities.timezone.bind('UTC'),
            conversationSchedulingCapabilities.clock.bind(clock),
          ],
        },
        {
          name: 'root',
          model: new MockLanguageModelV4({
            doStream: async (options) => {
              modelCalls += 1;
              if (modelCalls === 1) {
                return toolCallResult({
                  toolCallId: randomUUID(),
                  toolName: 'CronCreate',
                  input: JSON.stringify({
                    cron: '0 12 * * *',
                    prompt: 'daily',
                  }),
                });
              }
              return answerOrHold(options, () => {
                // The occurrence falls due while this turn runs, so only the
                // turn's settle, after the archive, finds it due.
                now = Date.parse('2030-01-01T12:01:00Z');
              });
            },
          }),
          sandbox: defineSandbox(new VirtualSandboxEnvironment()),
          plugins: [scheduled, conversationScheduling()],
        },
      );
      resources.use(await runtime.work());
      const sessionId = randomUUID();
      const root = { chatId: sessionId, userId: 'user-1' };
      const availabilityQueue = 'zukhruf-turns-settle-conversation-scheduling';
      await turnStatus(
        runtime,
        root,
        await startTurn(app, sessionId, 'create cron'),
        'completed',
        t.signal,
      );
      await drained(boss, availabilityQueue, t.signal);
      const tasks = runtime.plugin(scheduled);
      const task = await tasks.create('user-1', {
        idempotencyKey: randomUUID(),
        name: 'targeting',
        prompt: 'yearly',
        recurrence: '0 0 1 1 *',
        timezone: 'UTC',
        executionConfig: {
          target: { kind: 'existing-conversation', chatId: sessionId },
        },
      });
      const holding = await startTurn(app, sessionId, 'hold');
      await turnStatus(runtime, root, holding, 'running', t.signal);

      const response = await answer(await archive(app, sessionId));
      await turnStatus(runtime, root, holding, 'cancelled', t.signal);
      await drained(boss, availabilityQueue, t.signal);
      const cron = Object.values(
        cronStateSchema.parse(
          (await storage.store.getChat(sessionId))?.metadata,
        ).zukhruf.scheduling.cron,
      );
      const dispatching = cronStateSchema.parse(
        (await storage.store.getChat(sessionId))?.metadata,
      ).zukhruf.scheduling.dispatching;
      const refusedRun = await tasks.runNow('user-1', task.id, randomUUID());
      const refused = await waitFor(
        async () => {
          const run = await tasks.getRun('user-1', refusedRun.id);
          assert.equal(run.status, 'failed');
          return run.error;
        },
        { signal: t.signal },
      );
      const textsWhileArchived = await userTexts(app, sessionId);

      const restored = (await unarchive(app, sessionId)).status;
      now = Date.parse('2030-01-02T12:01:00Z');
      const resumedRun = await tasks.runNow('user-1', task.id, randomUUID());
      const resumed = await waitFor(
        async () => {
          const run = await tasks.getRun('user-1', resumedRun.id);
          assert.equal(run.status, 'completed');
          assert.deepStrictEqual((await userTexts(app, sessionId)).slice(3), [
            'yearly',
            'daily',
          ]);
          return run.status;
        },
        { signal: t.signal },
      );

      assert.deepStrictEqual(
        {
          response,
          cron: cron.map(({ generation, nextRunAt }) => ({
            generation,
            nextRunAt: new Date(nextRunAt).toISOString(),
          })),
          dispatching,
          refused,
          textsWhileArchived,
          restored,
          resumed,
        },
        {
          response: archived,
          cron: [{ generation: 2, nextRunAt: '2030-01-02T12:00:00.000Z' }],
          dispatching: undefined,
          refused: `chat "${sessionId}" is archived`,
          textsWhileArchived: ['create cron', 'hold', TURN_ABORTED],
          restored: 200,
          resumed: 'completed',
        },
      );
    });
  }),
);
