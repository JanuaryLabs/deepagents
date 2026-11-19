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

async function startTurn(app: Hono<HttpEnv>, sessionId: string) {
  const response = await app.request(`${MOUNT}/session/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: {
        id: `message-${randomUUID()}`,
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      },
      trigger: 'submit-message',
    }),
  });
  assert.equal(response.status, 202);
  return acceptedBodySchema.parse(await response.json()).turnId;
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
  const statusOf = async (turnId: string) =>
    turnStatusSchema.parse(
      await (
        await app.request(`${MOUNT}/session/${sessionId}/turn/${turnId}`)
      ).json(),
    ).status;

  const cancelled = await app.request(
    `${MOUNT}/session/${sessionId}/turn/${cancelledTurn}/cancel`,
    { method: 'POST' },
  );

  assert.deepStrictEqual(
    {
      cancel: cancelled.status,
      olderTurn: await statusOf(olderTurn),
      cancelledTurn: await statusOf(cancelledTurn),
      newerTurn: await statusOf(newerTurn),
    },
    {
      cancel: 204,
      olderTurn: 'queued',
      cancelledTurn: 'cancelled',
      newerTurn: 'queued',
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
