import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';

import type { AgentModel, AgentSandbox } from '@deepagents/context';
import {
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';
import {
  AgentRuntime,
  type ConsumeContext,
  type ConsumeOptions,
  SqliteMailboxStore,
  type TurnActivity,
  TurnQueue,
  type TurnRef,
  defineAgent,
} from '@deepagents/experimental/zukhruf';
import {
  type HttpEnv,
  type OwnerEvent,
  http,
} from '@deepagents/experimental/zukhruf/http';
import {
  schedules,
  schedulesCapabilities,
} from '@deepagents/experimental/zukhruf/schedules';
import {
  type ScheduledRunView,
  type ScheduledTaskView,
  schedulesHttp,
} from '@deepagents/experimental/zukhruf/schedules/http';

const MOUNT = '/zukhruf/v1';
const SCHEDULES = `${MOUNT}/schedules`;
const USER_HEADER = 'x-test-user';
const OWNER = 'owner-1';
const FAST_POLLING = {
  pollingIntervalSeconds: 0.5,
  notifyPollingIntervalSeconds: 0.5,
} as const;

class ControlledTurnQueue extends TurnQueue {
  readonly turns: TurnRef[] = [];
  #handler?: (turn: TurnRef, context: ConsumeContext) => Promise<void>;
  #options?: ConsumeOptions;

  push(turn: TurnRef): Promise<void> {
    this.turns.push(turn);
    return Promise.resolve();
  }

  getTurnActivity(): Promise<TurnActivity> {
    return Promise.resolve(this.turns.length === 0 ? 'idle' : 'queued');
  }

  getCurrentTurn(): Promise<TurnRef | undefined> {
    return Promise.resolve(this.turns[0]);
  }

  cancel(streamId: string): Promise<void> {
    const index = this.turns.findIndex((turn) => turn.streamId === streamId);
    if (index >= 0) this.turns.splice(index, 1);
    return Promise.resolve();
  }

  consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    this.#handler = handler;
    this.#options = options;
    return Promise.resolve({
      [Symbol.asyncDispose]: () => {
        this.#handler = undefined;
        this.#options = undefined;
        return Promise.resolve();
      },
    });
  }

  resumeParked(): Promise<void> {
    return Promise.resolve();
  }

  async runNext(): Promise<void> {
    const turn = this.turns.shift();
    assert(turn, 'expected a queued turn');
    assert(this.#handler, 'expected a running queue consumer');
    try {
      await this.#handler(turn, {
        signal: new AbortController().signal,
        park: () => Promise.resolve(),
      });
      await this.#options?.onSettled?.(turn);
    } catch (error) {
      await this.#options?.onOrphaned(
        turn,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function completingModel() {
  return new MockLanguageModelV4({
    provider: 'test',
    modelId: 'scheduled-model',
    doStream: async () => {
      const chunks: LanguageModelV4StreamPart[] = [
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'Scheduled work done.' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

interface Harness extends AsyncDisposable {
  app: Hono<HttpEnv>;
  queue: ControlledTurnQueue;
  runtime: AgentRuntime;
}

/** One real runtime, one real scheduler, one real HTTP projection. */
async function harness(options: { withSchedules?: boolean } = {}) {
  const resources = new AsyncDisposableStack();
  const database = resources.adopt(new PGlite(), (value) => value.close());
  const boss = resources.adopt(
    new PgBoss({
      db: fromPglite(database),
      backend: 'pglite',
      schedule: false,
    }),
    (value) => value.stop({ graceful: false }),
  );
  boss.on('error', () => {});
  await boss.start();
  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (value) => value.close(),
  );
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  const scheduled = schedules({
    queue: `scheduled-http-${randomUUID()}`,
    queueOptions: { notify: true },
    reconciliationIntervalMs: 50,
    workerOptions: FAST_POLLING,
  });
  const queue = new ControlledTurnQueue();
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'scheduled-agent',
      model: completingModel() as unknown as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      plugins: [scheduled],
    }),
    {
      store: new InMemoryContextStore(),
      streams: new StreamManager({
        store: streamStore,
        changeSource: new PollingChangeSource({ reads: streamStore }),
      }),
      queue,
      mailboxStore,
      bindings: [
        schedulesCapabilities.boss.bind(boss),
        schedulesCapabilities.transaction.bind((operation) =>
          database.transaction((tx) => operation(fromPglite(tx))),
        ),
      ],
    },
  );
  await runtime.initialize();
  resources.use(await runtime.work());

  const app = new Hono<HttpEnv>();
  app.use(`${MOUNT}/*`, (context, next) => {
    const userId = context.req.header(USER_HEADER);
    if (userId) context.set('userId', userId);
    return next();
  });
  app.route(
    MOUNT,
    options.withSchedules === false
      ? http(runtime)
      : http(runtime, schedulesHttp(scheduled)),
  );

  return {
    app,
    queue,
    runtime,
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  } satisfies Harness;
}

function request(
  app: Hono<HttpEnv>,
  path: string,
  init: RequestInit & { user?: string; idempotencyKey?: string } = {},
) {
  const { user = OWNER, idempotencyKey, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set(USER_HEADER, user);
  if (rest.body) headers.set('content-type', 'application/json');
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
  return app.request(path, { ...rest, headers });
}

function json(body: unknown) {
  return { body: JSON.stringify(body), method: 'POST' };
}

const definition = {
  name: 'Daily brief',
  prompt: 'Summarise what needs attention today.',
  recurrence: '0 8 * * 1-5',
  timezone: 'Asia/Amman',
  target: { kind: 'new-conversation' as const },
};

async function createTask(
  app: Hono<HttpEnv>,
  overrides: Partial<typeof definition> = {},
  key = randomUUID(),
  user = OWNER,
) {
  const response = await request(app, `${SCHEDULES}/tasks`, {
    ...json({ ...definition, ...overrides }),
    idempotencyKey: key,
    user,
  });
  assert.equal(response.status, 200);
  return { key, task: (await response.json()) as ScheduledTaskView };
}

function eventReader(response: Response) {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async next(): Promise<OwnerEvent> {
      while (true) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (frame.startsWith('data: ')) {
            return JSON.parse(frame.slice('data: '.length)) as OwnerEvent;
          }
          continue;
        }
        const { done, value } = await reader.read();
        assert.equal(done, false, 'event stream ended');
        buffered += decoder.decode(value, { stream: true });
      }
    },
    close() {
      void reader.cancel();
    },
  };
}

test('discovery advertises the schedules capability only when it is composed', async () => {
  await using withCapability = await harness();
  await using withoutCapability = await harness({ withSchedules: false });

  const present = await (
    await request(withCapability.app, `${MOUNT}/info`)
  ).json();
  const absent = await (
    await request(withoutCapability.app, `${MOUNT}/info`)
  ).json();

  assert.deepEqual(
    (present as { capabilities: Record<string, unknown> }).capabilities
      .schedules,
    { href: SCHEDULES },
  );
  assert.equal(
    (absent as { capabilities: Record<string, unknown> }).capabilities
      .schedules,
    undefined,
  );
  assert.equal(
    (await request(withoutCapability.app, `${SCHEDULES}/tasks`)).status,
    404,
  );
  assert.equal(
    (await withCapability.app.request(`${SCHEDULES}/tasks`)).status,
    401,
  );
});

test('owner events announce schedule task and worker-run changes without leaking another owner', async (t) => {
  await using h = await harness();
  const response = await request(h.app, `${MOUNT}/events`);
  assert.equal(response.status, 200);
  const events = eventReader(response);
  try {
    assert.deepEqual(await events.next(), { type: 'ready' });

    const foreign = await createTask(h.app, {}, randomUUID(), 'owner-2');
    const { task } = await createTask(h.app);
    assert.notEqual(foreign.task.id, task.id);
    assert.deepEqual(await events.next(), {
      type: 'change',
      resource: 'schedule-task',
      id: task.id,
    });

    const accepted = await request(h.app, `${SCHEDULES}/tasks/${task.id}/run`, {
      method: 'POST',
      idempotencyKey: randomUUID(),
    });
    const run = (await accepted.json()) as ScheduledRunView;
    assert.deepEqual(await events.next(), {
      type: 'change',
      resource: 'schedule-run',
      id: run.id,
      taskId: task.id,
    });
    await t.waitFor(() => assert.equal(h.queue.turns.length, 1), {
      interval: 20,
      timeout: 10_000,
    });
    let workerChange = await events.next();
    while (
      workerChange.type !== 'change' ||
      workerChange.resource !== 'schedule-run' ||
      workerChange.id !== run.id
    ) {
      workerChange = await events.next();
    }
    assert.deepEqual(workerChange, {
      type: 'change',
      resource: 'schedule-run',
      id: run.id,
      taskId: task.id,
    });
  } finally {
    events.close();
  }
});

test('task lifecycle is idempotent, owner-scoped, and free of scheduler bookkeeping', async () => {
  await using h = await harness();
  const { app } = h;

  const { key, task } = await createTask(app);
  assert.deepEqual(
    { name: task.name, status: task.status, target: task.target },
    { name: definition.name, status: 'active', target: definition.target },
  );
  assert.deepEqual(Object.keys(task).toSorted(), [
    'archivedAt',
    'createdAt',
    'id',
    'name',
    'nextRunAt',
    'prompt',
    'recurrence',
    'status',
    'target',
    'timezone',
    'updatedAt',
  ]);

  const repeat = await createTask(app, {}, key);
  assert.equal(repeat.task.id, task.id);

  const listed = await request(app, `${SCHEDULES}/tasks`);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    ((await listed.json()) as ScheduledTaskView[]).map(({ id }) => id),
    [task.id],
  );

  assert.deepEqual(
    await (
      await request(app, `${SCHEDULES}/tasks`, { user: 'owner-2' })
    ).json(),
    [],
  );
  const foreign = await request(app, `${SCHEDULES}/tasks/${task.id}`, {
    user: 'owner-2',
  });
  const missing = await request(app, `${SCHEDULES}/tasks/${randomUUID()}`);
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await foreign.json(), await missing.json());

  const paused = await request(app, `${SCHEDULES}/tasks/${task.id}/pause`, {
    method: 'POST',
  });
  assert.equal(((await paused.json()) as ScheduledTaskView).status, 'paused');

  const edited = await request(app, `${SCHEDULES}/tasks/${task.id}`, {
    body: JSON.stringify({
      prompt: 'Summarise only blocking issues.',
      target: { kind: 'existing-conversation', chatId: 'chat-existing' },
    }),
    method: 'PATCH',
  });
  assert.equal(edited.status, 400, 'unknown target conversation is rejected');

  const renamed = await request(app, `${SCHEDULES}/tasks/${task.id}`, {
    body: JSON.stringify({ name: 'Weekday brief' }),
    method: 'PATCH',
  });
  assert.equal(
    ((await renamed.json()) as ScheduledTaskView).name,
    'Weekday brief',
  );

  const resumed = await request(app, `${SCHEDULES}/tasks/${task.id}/resume`, {
    method: 'POST',
  });
  assert.equal(((await resumed.json()) as ScheduledTaskView).status, 'active');

  const earlyPurge = await request(app, `${SCHEDULES}/tasks/${task.id}`, {
    method: 'DELETE',
  });
  assert.equal(earlyPurge.status, 409, 'purge requires an archived task');

  const archived = await request(app, `${SCHEDULES}/tasks/${task.id}/archive`, {
    method: 'POST',
  });
  const archivedTask = (await archived.json()) as ScheduledTaskView;
  assert.equal(archivedTask.status, 'archived');
  assert.equal(archivedTask.nextRunAt, null);

  const purge = await request(app, `${SCHEDULES}/tasks/${task.id}`, {
    method: 'DELETE',
  });
  assert.equal(purge.status, 204);
  assert.equal(
    (await request(app, `${SCHEDULES}/tasks/${task.id}`)).status,
    404,
  );
});

test('malformed schedule definitions are rejected at the boundary', async () => {
  await using h = await harness();
  const { app } = h;

  const cases: Array<[string, Record<string, unknown>]> = [
    ['bad timezone', { ...definition, timezone: 'Not/A_Zone' }],
    ['bad cron', { ...definition, recurrence: 'not a cron' }],
    ['unknown field', { ...definition, notifications: 'important' }],
    ['blank name', { ...definition, name: '   ' }],
  ];
  for (const [label, body] of cases) {
    const response = await request(app, `${SCHEDULES}/tasks`, {
      ...json(body),
      idempotencyKey: randomUUID(),
    });
    assert.equal(response.status, 400, label);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }

  const withoutKey = await request(app, `${SCHEDULES}/tasks`, json(definition));
  assert.equal(withoutKey.status, 400, 'Idempotency-Key is required');

  const { task } = await createTask(app);
  const emptyPatch = await request(app, `${SCHEDULES}/tasks/${task.id}`, {
    body: JSON.stringify({}),
    method: 'PATCH',
  });
  assert.equal(emptyPatch.status, 400);
  assert.equal(
    (await request(app, `${SCHEDULES}/tasks/not-a-uuid`)).status,
    400,
  );
});

test('Run now carries scheduled provenance into its own fresh conversation', async (t) => {
  await using h = await harness();
  const { app, queue, runtime } = h;
  const { task } = await createTask(app);

  const key = randomUUID();
  const accepted = await request(app, `${SCHEDULES}/tasks/${task.id}/run`, {
    method: 'POST',
    idempotencyKey: key,
  });
  assert.equal(accepted.status, 202);
  const run = (await accepted.json()) as ScheduledRunView;
  assert.deepEqual(
    { taskId: run.taskId, trigger: run.trigger, status: run.status },
    { taskId: task.id, trigger: 'manual', status: 'dispatching' },
  );
  assert.deepEqual(Object.keys(run).toSorted(), [
    'conversation',
    'createdAt',
    'error',
    'finishedAt',
    'id',
    'occurrenceAt',
    'prompt',
    'reviewStatus',
    'startedAt',
    'status',
    'target',
    'taskId',
    'trigger',
    'updatedAt',
  ]);

  const repeat = await request(app, `${SCHEDULES}/tasks/${task.id}/run`, {
    method: 'POST',
    idempotencyKey: key,
  });
  assert.equal(((await repeat.json()) as ScheduledRunView).id, run.id);

  await t.waitFor(() => assert.equal(queue.turns.length, 1), {
    interval: 20,
    timeout: 10_000,
  });
  const [queued] = queue.turns;
  assert.equal(queued.chatId, run.id, 'fresh runs own a conversation per run');
  assert(queued.kind === 'message');
  assert.deepEqual(queued.message.metadata, {
    zukhruf: {
      origin: 'scheduled-task',
      scheduledTask: {
        taskId: task.id,
        runId: run.id,
        trigger: 'manual',
        occurrenceAt: run.occurrenceAt,
      },
    },
  });

  await queue.runNext();
  const completed = await waitForRun(t, app, run.id, 'completed');
  assert.deepEqual(completed.conversation, {
    chatId: run.id,
    turnId: queued.streamId,
  });
  assert.equal(completed.reviewStatus, 'pending_review');
  assert.equal(
    (
      await runtime
        .observe({ chatId: run.id, userId: OWNER })
        .engine.getMessages()
    ).some(({ role }) => role === 'assistant'),
    true,
  );
});

test('the inbox retains unreviewed runs until review is explicit', async (t) => {
  await using h = await harness();
  const { app, queue } = h;
  const { task } = await createTask(app);

  const accepted = await request(app, `${SCHEDULES}/tasks/${task.id}/run`, {
    method: 'POST',
    idempotencyKey: randomUUID(),
  });
  const run = (await accepted.json()) as ScheduledRunView;
  await t.waitFor(() => assert.equal(queue.turns.length, 1), {
    interval: 20,
    timeout: 10_000,
  });
  await queue.runNext();
  await waitForRun(t, app, run.id, 'completed');

  assert.deepEqual(
    (await inbox(app)).map(({ id }) => id),
    [run.id],
  );

  const opened = await request(app, `${SCHEDULES}/runs/${run.id}`);
  assert.equal(
    ((await opened.json()) as ScheduledRunView).reviewStatus,
    'pending_review',
    'opening a run never reviews it',
  );
  assert.deepEqual(
    (await inbox(app)).map(({ id }) => id),
    [run.id],
  );

  const archived = await request(app, `${SCHEDULES}/tasks/${task.id}/archive`, {
    method: 'POST',
  });
  assert.equal(archived.status, 200);
  assert.deepEqual(
    (await inbox(app)).map(({ id }) => id),
    [run.id],
    'archiving a task never auto-reviews its retained runs',
  );

  assert.deepEqual(await inbox(app, 'owner-2'), []);

  const reviewed = await request(app, `${SCHEDULES}/runs/${run.id}/review`, {
    method: 'POST',
  });
  assert.equal(
    ((await reviewed.json()) as ScheduledRunView).reviewStatus,
    'reviewed',
  );
  assert.deepEqual(await inbox(app), []);
  assert.deepEqual(
    (
      (await (
        await request(app, `${SCHEDULES}/tasks/${task.id}/runs`)
      ).json()) as ScheduledRunView[]
    ).map(({ id }) => id),
    [run.id],
    'review never removes a run from its task history',
  );

  const purge = await request(app, `${SCHEDULES}/tasks/${task.id}`, {
    method: 'DELETE',
  });
  assert.equal(purge.status, 204);
  assert.equal(
    (await request(app, `${SCHEDULES}/runs/${run.id}`)).status,
    404,
    'purging a task removes its runs',
  );
});

test('a run targeting an existing conversation keeps that conversation', async (t) => {
  await using h = await harness();
  const { app, queue, runtime } = h;
  const conversation = { chatId: randomUUID(), userId: OWNER };
  await runtime.createSession(conversation);

  const { task } = await createTask(app, {
    target: {
      kind: 'existing-conversation',
      chatId: conversation.chatId,
    } as never,
  });
  assert.deepEqual(task.target, {
    kind: 'existing-conversation',
    chatId: conversation.chatId,
  });

  const accepted = await request(app, `${SCHEDULES}/tasks/${task.id}/run`, {
    method: 'POST',
    idempotencyKey: randomUUID(),
  });
  const run = (await accepted.json()) as ScheduledRunView;
  await t.waitFor(() => assert.equal(queue.turns.length, 1), {
    interval: 20,
    timeout: 10_000,
  });
  assert.equal(queue.turns[0].chatId, conversation.chatId);

  await queue.runNext();
  const completed = await waitForRun(t, app, run.id, 'completed');
  assert.deepEqual(completed.conversation, {
    chatId: conversation.chatId,
    turnId: queue.turns.at(-1)?.streamId ?? completed.conversation?.turnId,
  });
});

async function inbox(app: Hono<HttpEnv>, user = OWNER) {
  const response = await request(app, `${SCHEDULES}/runs/inbox`, { user });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()) as ScheduledRunView[];
}

async function waitForRun(
  t: TestContext,
  app: Hono<HttpEnv>,
  runId: string,
  status: ScheduledRunView['status'],
) {
  let run!: ScheduledRunView;
  await t.waitFor(
    async () => {
      const response = await request(app, `${SCHEDULES}/runs/${runId}`);
      assert.equal(response.status, 200);
      run = (await response.json()) as ScheduledRunView;
      assert.equal(run.status, status);
    },
    { interval: 20, timeout: 10_000 },
  );
  return run;
}
