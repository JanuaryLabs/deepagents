import { Hono } from 'hono';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { StreamPart } from '@deepagents/context';
import type { AgentPluginDefinition } from '@deepagents/experimental/zukhruf';
import {
  type HttpEnv,
  type HttpProjection,
  ZUKHRUF_SESSION_ID_HEADER,
  http,
  projectHttp,
} from '@deepagents/experimental/zukhruf/http';

type TestRuntime = Parameters<typeof http>[0];

const MOUNT_PATH = '/zukhruf/v1';
const mounted = (path: string) => `${MOUNT_PATH}${path}`;

const runtimeInfo = {
  root: 'assistant',
  agents: [
    {
      name: 'assistant',
      model: { provider: 'test', modelId: 'test-model' },
      tools: ['search'],
      subagents: [],
    },
  ],
} satisfies TestRuntime['info'];

const emptyEngine = {
  getMessages: () => Promise.resolve([]),
};

function createRuntime(overrides: Partial<TestRuntime> = {}) {
  const runtime: TestRuntime = {
    info: runtimeInfo,
    plugin() {
      throw new Error('plugin is not installed');
    },
    async createSession() {},
    async enqueue() {
      return {
        id: 'internal-turn-id',
        stream: new ReadableStream<StreamPart>(),
      };
    },
    async listHistory() {
      return [];
    },
    observe() {
      return {
        engine: emptyEngine,
        async cancel() {},
        async resume() {
          return null;
        },
        async status() {
          return undefined;
        },
      };
    },
    async sessionExists() {
      return true;
    },
  };
  return Object.assign(runtime, overrides);
}

function createApp(runtime: TestRuntime, ...projections: HttpProjection[]) {
  const app = new Hono<HttpEnv>();
  app.use(async (context, next) => {
    context.set('userId', 'user-1');
    await next();
  });
  app.route(MOUNT_PATH, http(runtime, ...projections));
  app.get('/health', (context) => context.text('ok'));
  return app;
}

function createUnauthenticatedApp(
  runtime: TestRuntime,
  ...projections: HttpProjection[]
) {
  const app = new Hono<HttpEnv>();
  app.route(MOUNT_PATH, http(runtime, ...projections));
  return app;
}

test('POST /zukhruf/v1/session creates one idempotent durable session', async () => {
  const created: Array<{ chatId: string; userId: string }> = [];
  const enqueued: Array<{
    conversation: { chatId: string; userId: string };
    turn: Parameters<TestRuntime['enqueue']>[1];
  }> = [];
  const runtime = createRuntime({
    async createSession(conversation) {
      created.push(conversation);
    },
    async enqueue(conversation, turn) {
      enqueued.push({ conversation, turn });
      return {
        id: 'internal-turn-id',
        stream: new ReadableStream<StreamPart>(),
      };
    },
  });

  const app = createApp(runtime);
  const message = {
    id: 'message-1',
    role: 'user' as const,
    parts: [
      { type: 'text' as const, text: 'Hello' },
      {
        type: 'file' as const,
        mediaType: 'text/plain',
        filename: 'note.txt',
        url: 'data:text/plain;base64,bm90ZQ==',
      },
    ],
    metadata: { locale: { language: 'Arabic' } },
  };
  const create = () =>
    app.request(mounted('/session'), {
      body: JSON.stringify({ message, trigger: 'submit-message' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

  const first = await create();
  const firstBody = (await first.json()) as {
    ok: boolean;
    sessionId: string;
    turnId: string;
  };
  const retry = await create();
  const retryBody = (await retry.json()) as typeof firstBody;

  assert.equal(first.status, 202);
  assert.equal(firstBody.ok, true);
  assert.match(firstBody.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(
    first.headers.get(ZUKHRUF_SESSION_ID_HEADER),
    firstBody.sessionId,
  );
  assert.equal(retryBody.sessionId, firstBody.sessionId);
  assert.equal(firstBody.turnId, 'internal-turn-id');
  assert.deepEqual(created, [
    { chatId: firstBody.sessionId, userId: 'user-1' },
    { chatId: firstBody.sessionId, userId: 'user-1' },
  ]);
  assert.deepEqual(enqueued, [
    {
      conversation: { chatId: firstBody.sessionId, userId: 'user-1' },
      turn: { message, trigger: 'submit-message' },
    },
    {
      conversation: { chatId: firstBody.sessionId, userId: 'user-1' },
      turn: { message, trigger: 'submit-message' },
    },
  ]);

  const health = await app.request('/health');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
});

test('POST /zukhruf/v1/session validates its public boundary', async (t) => {
  const app = createApp(createRuntime());
  const request = (input: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
  }) =>
    app.request(mounted('/session'), {
      ...input,
      method: input.method ?? 'POST',
    });

  await t.test('requires POST', async () => {
    const response = await request({ method: 'GET' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  });

  await t.test('requires a valid AI SDK message', async () => {
    const response = await request({
      body: JSON.stringify({
        message: { id: 'message-1', role: 'user', parts: [] },
        trigger: 'submit-message',
      }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { cause: { code: string } };
    assert.equal(body.cause.code, 'api/validation-failed');
  });

  await t.test('accepts only message, trigger, and client tools', async () => {
    const response = await request({
      body: JSON.stringify({
        input: 'legacy',
        message: {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
        trigger: 'submit-message',
      }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(response.status, 400);
  });

  await t.test('validates client tool definitions', async () => {
    const response = await request({
      body: JSON.stringify({
        message: {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
        tools: {
          ask_user_question: { description: '', inputSchema: [] },
        },
        trigger: 'submit-message',
      }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(response.status, 400);
  });

  await t.test('does not regenerate before a session exists', async () => {
    const response = await request({
      body: JSON.stringify({
        message: {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
        trigger: 'regenerate-message',
      }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(response.status, 400);
  });

  await t.test('reports malformed JSON with a stable error code', async () => {
    const response = await request({
      body: '{',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { cause: { code: string } };
    assert.equal(body.cause.code, 'api/invalid-json');
  });

  await t.test('bounds the request body', async () => {
    const response = await request({
      body: JSON.stringify({
        message: {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'x'.repeat(11 * 1024) }],
        },
        trigger: 'submit-message',
      }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { cause: { code: string } };
    assert.equal(body.cause.code, 'api/payload-too-large');
  });
});

test('POST /zukhruf/v1/session/:sessionId continues an existing session', async () => {
  const sessionId = '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15';
  const enqueued: Array<{
    conversation: { chatId: string; userId: string };
    turn: Parameters<TestRuntime['enqueue']>[1];
  }> = [];
  const runtime = createRuntime({
    async enqueue(conversation, turn) {
      enqueued.push({ conversation, turn });
      return {
        id: 'internal-turn-id',
        stream: new ReadableStream<StreamPart>(),
      };
    },
  });
  const path = mounted('/session/:sessionId').replace(':sessionId', sessionId);
  const message = {
    id: 'message-2',
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: 'Continue' }],
    metadata: { locale: { language: 'Arabic' } },
  };
  const tools = {
    ask_user_question: {
      description: 'Ask the user a question',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  };
  const response = await createApp(runtime).request(path, {
    body: JSON.stringify({ message, tools, trigger: 'submit-message' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    sessionId,
    turnId: 'internal-turn-id',
  });
  assert.deepEqual(enqueued, [
    {
      conversation: { chatId: sessionId, userId: 'user-1' },
      turn: { message, tools, trigger: 'submit-message' },
    },
  ]);

  const regenerated = await createApp(runtime).request(path, {
    body: JSON.stringify({ message, trigger: 'regenerate-message' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(regenerated.status, 202);
  assert.deepEqual(enqueued[1], {
    conversation: { chatId: sessionId, userId: 'user-1' },
    turn: { message, trigger: 'regenerate-message' },
  });

  const assistant = {
    id: 'internal-turn-id',
    role: 'assistant' as const,
    parts: [{ type: 'text' as const, text: 'Client supplied continuation' }],
  };
  const continued = await createApp(runtime).request(path, {
    body: JSON.stringify({ message: assistant, trigger: 'submit-message' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(continued.status, 202);
  assert.deepEqual(enqueued[2], {
    conversation: { chatId: sessionId, userId: 'user-1' },
    turn: { message: assistant, trigger: 'submit-message' },
  });

  const invalidAssistantRegeneration = await createApp(runtime).request(path, {
    body: JSON.stringify({
      message: {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Old response' }],
      },
      trigger: 'regenerate-message',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(invalidAssistantRegeneration.status, 400);

  const missing = await createApp(
    createRuntime({ sessionExists: async () => false }),
  ).request(path, {
    body: JSON.stringify({ message, trigger: 'submit-message' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as { cause: { code: string } }).cause.code,
    'zukhruf/session-not-found',
  );
});

test('GET /zukhruf/v1/session/:sessionId returns the authenticated conversation', async () => {
  const sessionId = '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15';
  const messages = [
    {
      id: 'message-1',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Hello' }],
    },
  ];
  const observed: Array<{ chatId: string; userId: string }> = [];
  const runtime = createRuntime({
    observe(conversation) {
      observed.push(conversation);
      return {
        engine: { getMessages: () => Promise.resolve(messages) },
        async cancel() {},
        async resume() {
          return null;
        },
        async status() {
          return undefined;
        },
      };
    },
  });

  const response = await createApp(runtime).request(
    mounted('/session/:sessionId').replace(':sessionId', sessionId),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sessionId, messages });
  assert.deepEqual(observed, [{ chatId: sessionId, userId: 'user-1' }]);
});

test('POST /zukhruf/v1/session/:sessionId/cancel cancels the current turn', async () => {
  const sessionId = '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15';
  const cancelled: Array<{ chatId: string; userId: string }> = [];
  const runtime = createRuntime({
    observe(conversation) {
      return {
        engine: emptyEngine,
        async cancel() {
          cancelled.push(conversation);
        },
        async resume() {
          return null;
        },
        async status() {
          return undefined;
        },
      };
    },
  });
  const path = mounted('/session/:sessionId/cancel').replace(
    ':sessionId',
    sessionId,
  );
  const app = createApp(runtime);
  const response = await app.request(path, { method: 'POST' });

  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.deepEqual(cancelled, [{ chatId: sessionId, userId: 'user-1' }]);

  const wrongMethod = await app.request(path);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
});

test('GET /zukhruf/v1/session/:sessionId/turn/:turnId exposes the exact durable turn outcome', async () => {
  const sessionId = '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15';
  const turnId = 'e4ee8b3c-9054-5bc1-9d88-a0db1a40f759';
  const observed: string[] = [];
  const runtime = createRuntime({
    observe() {
      return {
        engine: emptyEngine,
        async cancel() {},
        async resume() {
          return null;
        },
        async status(id?: string) {
          observed.push(id ?? 'current');
          return {
            status: 'failed' as const,
            startedAt: 1_000,
            finishedAt: 2_000,
            error: 'model crashed',
          };
        },
      };
    },
  });
  const path = mounted('/session/:sessionId/turn/:turnId')
    .replace(':sessionId', sessionId)
    .replace(':turnId', turnId);
  const response = await createApp(runtime).request(path);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    sessionId,
    turnId,
    status: 'failed',
    startedAt: 1_000,
    finishedAt: 2_000,
    error: 'model crashed',
  });
  assert.deepEqual(observed, [turnId]);
});

test('POST /zukhruf/v1/session/:sessionId/turn/:turnId/cancel cancels only that turn', async () => {
  const sessionId = '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15';
  const turnId = 'e4ee8b3c-9054-5bc1-9d88-a0db1a40f759';
  const cancelled: Array<string | undefined> = [];
  const runtime = createRuntime({
    observe() {
      return {
        engine: emptyEngine,
        async cancel(id?: string) {
          cancelled.push(id);
        },
        async resume() {
          return null;
        },
        async status() {
          return undefined;
        },
      };
    },
  });
  const path = mounted('/session/:sessionId/turn/:turnId/cancel')
    .replace(':sessionId', sessionId)
    .replace(':turnId', turnId);
  const response = await createApp(runtime).request(path, { method: 'POST' });

  assert.equal(response.status, 204);
  assert.deepEqual(cancelled, [turnId]);
});

test('GET /zukhruf/v1/session/:sessionId/stream replays and tails the authenticated session', async () => {
  const observed: Array<{ chatId: string; userId: string }> = [];
  const runtime = createRuntime({
    observe(conversation) {
      observed.push(conversation);
      return {
        engine: emptyEngine,
        async cancel() {},
        async resume() {
          return new ReadableStream<StreamPart>({
            start(controller) {
              controller.enqueue({
                delta: 'Hello',
                id: 'text-1',
                type: 'text-delta',
              });
              controller.close();
            },
          });
        },
        async status() {
          return undefined;
        },
      };
    },
  });
  const app = createApp(runtime);
  const sessionId = '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15';

  const response = await app.request(
    mounted('/session/:sessionId/stream').replace(':sessionId', sessionId),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1');
  const events = (await response.text()).trim().split('\n\n');
  assert.deepEqual(JSON.parse(events[0].slice('data: '.length)), {
    delta: 'Hello',
    id: 'text-1',
    type: 'text-delta',
  });
  assert.equal(events[1], 'data: [DONE]');
  assert.deepEqual(observed, [{ chatId: sessionId, userId: 'user-1' }]);
});

test('GET /zukhruf/v1/session/:sessionId/stream returns 404 without a durable stream', async () => {
  const app = createApp(createRuntime());
  const path = mounted('/session/:sessionId/stream').replace(
    ':sessionId',
    '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15',
  );

  const response = await app.request(path);
  assert.equal(response.status, 404);
  const body = (await response.json()) as { cause: { code: string } };
  assert.equal(body.cause.code, 'zukhruf/session-stream-not-found');

  const wrongMethod = await app.request(path, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  const wrongMethodBody = (await wrongMethod.json()) as {
    cause: { code: string };
  };
  assert.equal(wrongMethodBody.cause.code, 'api/method-not-allowed');
});

test('GET /zukhruf/v1/info and health expose runtime and deployment metadata', async () => {
  const runtime = createRuntime();
  const authenticated = createApp(runtime);
  const info = await authenticated.request(mounted('/info'));
  assert.equal(info.status, 200);
  assert.deepEqual(await info.json(), {
    ...runtime.info,
    capabilities: {
      history: { href: mounted('/history') },
      chat: { href: mounted('/session') },
    },
  });

  const unauthenticated = createUnauthenticatedApp(runtime);
  const health = await unauthenticated.request(mounted('/health'));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const head = await unauthenticated.request(mounted('/health'), {
    method: 'HEAD',
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const protectedInfo = await unauthenticated.request(mounted('/info'));
  assert.equal(protectedInfo.status, 401);
  assert.equal(
    ((await protectedInfo.json()) as { cause: { code: string } }).cause.code,
    'api/unauthenticated',
  );
});

test('discovery follows the host-selected Hono mount', async () => {
  const app = new Hono<HttpEnv>();
  app.use(async (context, next) => {
    context.set('userId', 'user-1');
    await next();
  });
  app.route('/chosen/by-host', http(createRuntime()));

  const discovery = (await (
    await app.request('/chosen/by-host/info')
  ).json()) as {
    capabilities: Record<string, { href: string }>;
  };
  assert.deepEqual(discovery.capabilities, {
    history: { href: '/chosen/by-host/history' },
    chat: { href: '/chosen/by-host/session' },
  });
});

test('GET /zukhruf/v1/history exposes runtime observations', async () => {
  const sessionId = '9d1f5c40-f250-5aa9-8979-2e0ef4fc2c15';
  const observedUsers: string[] = [];
  const runtime = createRuntime({
    async listHistory(userId) {
      observedUsers.push(userId ?? 'missing');
      return [
        {
          chatId: sessionId,
          userId: 'user-1',
          createdAt: 1,
          updatedAt: 2,
          messageCount: 1,
          status: 'running',
        },
      ];
    },
  });
  const app = createApp(runtime);

  const history = await app.request(mounted('/history'));
  assert.equal(history.status, 200);
  assert.equal(((await history.json()) as unknown[]).length, 1);
  assert.deepEqual(observedUsers, ['user-1']);
});

test('HTTP projections bind installed plugins behind the transport boundary', async () => {
  const reader = { read: () => 'ready' };
  const notices: AgentPluginDefinition<typeof reader> = {
    name: 'notices',
    create: () => reader,
  };
  const noticesHttp = projectHttp(notices, (plugin) => {
    const publicRoutes = new Hono<HttpEnv>().get('/notice-health', (context) =>
      context.json({ ok: true }),
    );
    const authenticatedRoutes = new Hono<HttpEnv>();
    authenticatedRoutes.get('/notices', (context) =>
      context.json({ notice: plugin.read() }),
    );
    return {
      capabilities: { notices: { path: '/notices' } },
      publicRoutes,
      authenticatedRoutes,
    };
  });
  const runtime = createRuntime({
    plugin: ((definition) => {
      assert.equal(definition, notices);
      return reader;
    }) as TestRuntime['plugin'],
  });

  const app = createApp(runtime, noticesHttp);
  assert.deepEqual(
    (
      (await (await app.request(mounted('/info'))).json()) as {
        capabilities: Record<string, { href: string }>;
      }
    ).capabilities.notices,
    { href: mounted('/notices') },
  );
  assert.deepEqual(await (await app.request(mounted('/notices'))).json(), {
    notice: 'ready',
  });
  assert.equal(
    (
      await createUnauthenticatedApp(runtime, noticesHttp).request(
        mounted('/notices'),
      )
    ).status,
    401,
  );
  assert.deepEqual(
    await (
      await createUnauthenticatedApp(runtime, noticesHttp).request(
        mounted('/notice-health'),
      )
    ).json(),
    { ok: true },
  );

  assert.throws(
    () => createApp(createRuntime(), noticesHttp),
    /plugin is not installed/,
  );
  const absent = createApp(createRuntime());
  assert.equal(
    (
      (await (await absent.request(mounted('/info'))).json()) as {
        capabilities: Record<string, unknown>;
      }
    ).capabilities.notices,
    undefined,
  );
  assert.equal((await absent.request(mounted('/notices'))).status, 404);
});

test('HTTP discovery rejects invalid contributed capabilities', () => {
  assert.throws(
    () =>
      http(createRuntime(), {
        project: () => ({
          capabilities: { history: { path: '/other' } },
        }),
      }),
    /duplicate capability "history"/,
  );
  assert.throws(
    () =>
      http(createRuntime(), {
        project: () => ({
          capabilities: { relative: { path: 'relative' } },
        }),
      }),
    /must use an absolute path/,
  );
});
