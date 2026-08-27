import { Hono } from 'hono';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { StreamPart } from '@deepagents/context';
import {
  ZUKHRUF_CREATE_SESSION_ROUTE_PATH,
  ZUKHRUF_HEALTH_ROUTE_PATH,
  ZUKHRUF_HISTORY_ROUTE_PATH,
  ZUKHRUF_INFO_ROUTE_PATH,
  ZUKHRUF_ROUTE_PREFIX,
  ZUKHRUF_SESSION_CANCEL_ROUTE_PATH,
  ZUKHRUF_SESSION_ID_HEADER,
  ZUKHRUF_SESSION_ROUTE_PATH,
  ZUKHRUF_SESSION_STREAM_ROUTE_PATH,
  ZUKHRUF_SESSION_TURN_CANCEL_ROUTE_PATH,
  ZUKHRUF_SESSION_TURN_ROUTE_PATH,
  zukhruf,
  zukhrufDiscovery,
} from '@deepagents/experimental/zukhruf';

type ProtocolRuntime = Parameters<typeof zukhruf>[0];

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
} satisfies ProtocolRuntime['info'];

const emptyEngine = {
  getMessages: () => Promise.resolve([]),
};

function createRuntime(overrides: Partial<ProtocolRuntime> = {}) {
  const runtime: ProtocolRuntime = {
    info: runtimeInfo,
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

function createApp(runtime: ProtocolRuntime) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use(async (context, next) => {
    context.set('userId', 'user-1');
    await next();
  });
  app.route(ZUKHRUF_ROUTE_PREFIX, zukhruf(runtime));
  app.get('/health', (context) => context.text('ok'));
  return app;
}

function createUnauthenticatedApp(runtime: ProtocolRuntime) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.route(ZUKHRUF_ROUTE_PREFIX, zukhruf(runtime));
  return app;
}

test('POST /zukhruf/v1/session creates one idempotent durable session', async () => {
  const created: Array<{ chatId: string; userId: string }> = [];
  const enqueued: Array<{
    conversation: { chatId: string; userId: string };
    turn: { id: string; input: string };
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
  const create = () =>
    app.request(ZUKHRUF_CREATE_SESSION_ROUTE_PATH, {
      body: JSON.stringify({ input: '  Hello  ' }),
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'message-1',
      },
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
      turn: { id: 'message-1', input: 'Hello' },
    },
    {
      conversation: { chatId: firstBody.sessionId, userId: 'user-1' },
      turn: { id: 'message-1', input: 'Hello' },
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
    app.request(ZUKHRUF_CREATE_SESSION_ROUTE_PATH, {
      ...input,
      method: input.method ?? 'POST',
    });

  await t.test('requires POST', async () => {
    const response = await request({ method: 'GET' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  });

  await t.test('requires an idempotency key', async () => {
    const response = await request({
      body: JSON.stringify({ input: 'Hello' }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { cause: { code: string } };
    assert.equal(body.cause.code, 'api/validation-failed');
  });

  await t.test('accepts only the input field', async () => {
    const response = await request({
      body: JSON.stringify({ continuationToken: 'no', input: 'Hello' }),
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'message-1',
      },
    });
    assert.equal(response.status, 400);
  });

  await t.test('reports malformed JSON with a stable error code', async () => {
    const response = await request({
      body: '{',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'message-1',
      },
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { cause: { code: string } };
    assert.equal(body.cause.code, 'api/invalid-json');
  });

  await t.test('bounds the request body', async () => {
    const response = await request({
      body: JSON.stringify({ input: 'x'.repeat(11 * 1024) }),
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'message-1',
      },
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
    turn: { id: string; input: string };
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
  const path = ZUKHRUF_SESSION_ROUTE_PATH.replace(':sessionId', sessionId);
  const response = await createApp(runtime).request(path, {
    body: JSON.stringify({ input: '  Continue  ' }),
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'message-2',
    },
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
      turn: { id: 'message-2', input: 'Continue' },
    },
  ]);

  const missing = await createApp(
    createRuntime({ sessionExists: async () => false }),
  ).request(path, {
    body: JSON.stringify({ input: 'Continue' }),
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'message-2',
    },
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
    ZUKHRUF_SESSION_ROUTE_PATH.replace(':sessionId', sessionId),
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
  const path = ZUKHRUF_SESSION_CANCEL_ROUTE_PATH.replace(
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
  const path = ZUKHRUF_SESSION_TURN_ROUTE_PATH.replace(
    ':sessionId',
    sessionId,
  ).replace(':turnId', turnId);
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
  const path = ZUKHRUF_SESSION_TURN_CANCEL_ROUTE_PATH.replace(
    ':sessionId',
    sessionId,
  ).replace(':turnId', turnId);
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
    ZUKHRUF_SESSION_STREAM_ROUTE_PATH.replace(':sessionId', sessionId),
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
  const path = ZUKHRUF_SESSION_STREAM_ROUTE_PATH.replace(
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
  const info = await authenticated.request(ZUKHRUF_INFO_ROUTE_PATH);
  assert.equal(info.status, 200);
  assert.deepEqual(await info.json(), zukhrufDiscovery(runtime));

  const unauthenticated = createUnauthenticatedApp(runtime);
  const health = await unauthenticated.request(ZUKHRUF_HEALTH_ROUTE_PATH);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const head = await unauthenticated.request(ZUKHRUF_HEALTH_ROUTE_PATH, {
    method: 'HEAD',
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const protectedInfo = await unauthenticated.request(ZUKHRUF_INFO_ROUTE_PATH);
  assert.equal(protectedInfo.status, 401);
  assert.equal(
    ((await protectedInfo.json()) as { cause: { code: string } }).cause.code,
    'api/unauthenticated',
  );
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

  const history = await app.request(ZUKHRUF_HISTORY_ROUTE_PATH);
  assert.equal(history.status, 200);
  assert.equal(((await history.json()) as unknown[]).length, 1);
  assert.deepEqual(observedUsers, ['user-1']);
});
