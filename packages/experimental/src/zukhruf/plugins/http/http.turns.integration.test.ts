import { PGlite } from '@electric-sql/pglite';
import { open } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import {
  SqliteContextStore,
  SqliteStreamStore,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

import { textResult } from '../../../testing/stream-results.fixture.ts';
import { streamsFor } from '../../../testing/streams-for.fixture.ts';

const MOUNT = '/zukhruf/v1';

const acceptedBodySchema = z.looseObject({ turnId: z.string() });
const turnStatusSchema = z.looseObject({
  sessionId: z.string(),
  turnId: z.string(),
  status: z.string(),
});
const errorBodySchema = z.looseObject({
  cause: z.looseObject({ code: z.string() }),
});

async function serve(resources: AsyncDisposableStack) {
  const database = resources.use(new PGlite());
  const boss = resources.adopt(
    new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
    (value) => value.stop({ graceful: false }),
  );
  boss.on('error', () => {});
  await boss.start();
  const queue = await PgBossTurnQueue.create(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  const streamStore = new SqliteStreamStore(resources.use(open(':memory:')));
  const runtime = resources.use(
    await new AgentRuntime(
      defineAgent({
        name: 'turns',
        model: new MockLanguageModelV4({
          doStream: async () => textResult('done'),
        }),
        instructions: [],
        sandbox: defineSandbox(() =>
          createVirtualSandbox({ fs: new InMemoryFs() }),
        ),
      }),
    ).initialize(
      defineStack(async () => ({
        store: new SqliteContextStore(resources.use(open(':memory:'))),
        streams: streamsFor(streamStore),
        queue,
        mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
      })),
    ),
  );
  const app = new Hono<HttpEnv>();
  app.use(`${MOUNT}/*`, (context, next) => {
    context.set('userId', 'user-1');
    return next();
  });
  app.route(MOUNT, http(runtime));
  return { app, runtime };
}

function postSession(
  app: Hono<HttpEnv>,
  sessionId: string,
  message: { id: string; role: 'user' | 'assistant' },
  trigger: 'submit-message' | 'regenerate-message' = 'submit-message',
) {
  return app.request(`${MOUNT}/session/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: { ...message, parts: [{ type: 'text', text: 'Hello' }] },
      trigger,
    }),
  });
}

async function startTurn(app: Hono<HttpEnv>, sessionId: string) {
  const response = await postSession(app, sessionId, {
    id: `message-${randomUUID()}`,
    role: 'user',
  });
  assert.equal(response.status, 202);
  return acceptedBodySchema.parse(await response.json()).turnId;
}

async function statusOf(app: Hono<HttpEnv>, sessionId: string, turnId: string) {
  const response = await app.request(
    `${MOUNT}/session/${sessionId}/turn/${turnId}`,
  );
  return turnStatusSchema.parse(await response.json()).status;
}

async function completedTurn(
  app: Hono<HttpEnv>,
  sessionId: string,
  signal: AbortSignal,
) {
  const turnId = await startTurn(app, sessionId);
  await waitFor(
    async () =>
      assert.equal(await statusOf(app, sessionId, turnId), 'completed'),
    { signal },
  );
  return turnId;
}

test('GET /session/:sessionId/turn/:turnId reports the outcome of the turn POST /session returned', async (t) => {
  await using resources = new AsyncDisposableStack();
  const { app, runtime } = await serve(resources);
  resources.use(await runtime.work());
  const sessionId = randomUUID();

  const turnId = await startTurn(app, sessionId);
  const accepted = await app.request(
    `${MOUNT}/session/${sessionId}/turn/${turnId}`,
  );
  assert.equal(accepted.status, 200);
  const outcome = await waitFor(
    async () => {
      const response = await app.request(
        `${MOUNT}/session/${sessionId}/turn/${turnId}`,
      );
      assert.equal(response.status, 200);
      const body = turnStatusSchema.parse(await response.json());
      assert.equal(body.status, 'completed');
      return body;
    },
    { signal: t.signal },
  );

  assert.deepStrictEqual(
    {
      sessionId: outcome.sessionId,
      turnId: outcome.turnId,
      status: outcome.status,
    },
    { sessionId, turnId, status: 'completed' },
  );
});

test('POST /session/:sessionId/turn/:turnId/cancel cancels only the turn POST /session returned', async () => {
  await using resources = new AsyncDisposableStack();
  const { app } = await serve(resources);
  const sessionId = randomUUID();
  const olderTurn = await startTurn(app, sessionId);
  const cancelledTurn = await startTurn(app, sessionId);
  const newerTurn = await startTurn(app, sessionId);

  const cancelled = await app.request(
    `${MOUNT}/session/${sessionId}/turn/${cancelledTurn}/cancel`,
    { method: 'POST' },
  );

  assert.deepStrictEqual(
    {
      cancel: cancelled.status,
      olderTurn: await statusOf(app, sessionId, olderTurn),
      cancelledTurn: await statusOf(app, sessionId, cancelledTurn),
      newerTurn: await statusOf(app, sessionId, newerTurn),
    },
    {
      cancel: 204,
      olderTurn: 'queued',
      cancelledTurn: 'cancelled',
      newerTurn: 'queued',
    },
  );
});

test('GET /session/:sessionId/turn/:turnId answers 404 for a turn of another session', async () => {
  await using resources = new AsyncDisposableStack();
  const { app } = await serve(resources);
  const sessionId = randomUUID();
  const otherSessionId = randomUUID();
  await startTurn(app, sessionId);
  const otherTurn = await startTurn(app, otherSessionId);

  const response = await app.request(
    `${MOUNT}/session/${sessionId}/turn/${otherTurn}`,
  );

  assert.equal(response.status, 404);
  assert.deepStrictEqual(await response.json(), {
    error: 'Session turn not found',
    cause: {
      code: 'zukhruf/session-turn-not-found',
      detail: `Turn ${otherTurn} does not exist in session ${sessionId}`,
    },
  });
});

test('POST /session/:sessionId/turn/:turnId/cancel answers 404 for a turn of another session and leaves that turn queued', async () => {
  await using resources = new AsyncDisposableStack();
  const { app } = await serve(resources);
  const sessionId = randomUUID();
  const otherSessionId = randomUUID();
  await startTurn(app, sessionId);
  const otherTurn = await startTurn(app, otherSessionId);

  const response = await app.request(
    `${MOUNT}/session/${sessionId}/turn/${otherTurn}/cancel`,
    { method: 'POST' },
  );

  assert.equal(response.status, 404);
  assert.deepStrictEqual(await response.json(), {
    error: 'Session turn not found',
    cause: {
      code: 'zukhruf/session-turn-not-found',
      detail: `Turn ${otherTurn} does not exist in session ${sessionId}`,
    },
  });
  assert.equal(await statusOf(app, otherSessionId, otherTurn), 'queued');
});

test('POST /session answers 409 for an approval continuation of a turn that is no longer the latest, and runs nothing', async (t) => {
  await using resources = new AsyncDisposableStack();
  const { app, runtime } = await serve(resources);
  resources.use(await runtime.work());
  const sessionId = randomUUID();
  const staleTurn = await completedTurn(app, sessionId, t.signal);
  await completedTurn(app, sessionId, t.signal);

  const response = await postSession(app, sessionId, {
    id: staleTurn,
    role: 'assistant',
  });

  assert.equal(response.status, 409);
  assert.deepStrictEqual(await response.json(), {
    error: 'Session turn is stale',
    cause: {
      code: 'zukhruf/session-turn-stale',
      detail: `Turn ${staleTurn} is not the latest turn of session ${sessionId}`,
    },
  });
  assert.equal(await statusOf(app, sessionId, staleTurn), 'completed');
});

test('POST /session answers 404 when asked to regenerate a message that never ran', async () => {
  await using resources = new AsyncDisposableStack();
  const { app } = await serve(resources);
  const sessionId = randomUUID();
  await startTurn(app, sessionId);

  const response = await postSession(
    app,
    sessionId,
    { id: `message-${randomUUID()}`, role: 'user' },
    'regenerate-message',
  );

  assert.equal(response.status, 404);
  const body = z
    .object({
      error: z.string(),
      cause: z.object({ code: z.string(), detail: z.string() }),
    })
    .parse(await response.json());
  assert.deepStrictEqual(
    {
      error: body.error,
      code: body.cause.code,
      detailNamesOnlyThisSession: new RegExp(
        `^Turn zukhruf-turn:\\S+ does not exist in session ${sessionId}$`,
      ).test(body.cause.detail),
    },
    {
      error: 'Session turn not found',
      code: 'zukhruf/session-turn-not-found',
      detailNamesOnlyThisSession: true,
    },
  );
});

test('the turn routes answer 400 for an id that is not a turn id, one defect at a time', async () => {
  await using resources = new AsyncDisposableStack();
  const { app } = await serve(resources);
  const sessionId = randomUUID();
  const turnId = await startTurn(app, sessionId);
  const [, scope, turn] = turnId.split(':');
  const nearMisses = [
    turn,
    `zukhruf-turn:${scope}`,
    `zukhruf-turn:${scope}:${turn}:extra`,
    `zukhruf-turn:not-a-uuid:${turn}`,
    `zukhruf-turn:${scope}:not-a-uuid`,
    `wrong-prefix:${scope}:${turn}`,
  ];

  const answers = await Promise.all(
    nearMisses.flatMap((id) => [
      app.request(`${MOUNT}/session/${sessionId}/turn/${id}`),
      app.request(`${MOUNT}/session/${sessionId}/turn/${id}/cancel`, {
        method: 'POST',
      }),
    ]),
  );

  assert.deepStrictEqual(
    await Promise.all(
      answers.map(async (response) => ({
        status: response.status,
        code: errorBodySchema.parse(await response.json()).cause.code,
      })),
    ),
    answers.map(() => ({ status: 400, code: 'api/validation-failed' })),
  );
});
