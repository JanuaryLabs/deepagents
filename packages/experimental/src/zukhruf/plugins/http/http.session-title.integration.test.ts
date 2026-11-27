import { PGlite } from '@electric-sql/pglite';
import { waitFor } from '@zukhruf/testing/async';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import { InMemoryContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

import { buildSandbox } from '../../../testing/build-sandbox.fixture.ts';
import { ControlledAgentStorage } from '../../../testing/controlled-agent-storage.fixture.ts';
import { textResult } from '../../../testing/stream-results.fixture.ts';
import { streamsFor } from '../../../testing/streams-for.fixture.ts';

const MOUNT = '/zukhruf/v1';

const acceptedBodySchema = z.looseObject({ turnId: z.string() });
const historySchema = z.array(
  z.looseObject({ chatId: z.string(), title: z.string().optional() }),
);
const errorBodySchema = z.looseObject({
  error: z.string(),
  cause: z.looseObject({ code: z.string() }),
});

const stack = defineStack(async (resources) => {
  const database = resources.use(new PGlite());
  const boss = resources.adopt(
    new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
    (boss) => boss.stop({ graceful: false }),
  );
  boss.on('error', (error) => {
    throw error;
  });
  await boss.start();
  return {
    storage: new ControlledAgentStorage({
      queue: await PgBossTurnQueue.create(boss, {
        pollingIntervalSeconds: 0.5,
        schema: 'pgboss',
      }),
      store: new InMemoryContextStore(),
      streams: streamsFor(
        resources.adopt(new SqliteStreamStore(':memory:'), (store) =>
          store.close(),
        ),
      ),
      mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
    }),
  };
});

function setTitle(
  app: Hono<HttpEnv>,
  sessionId: string,
  body: unknown,
  userId = 'user-1',
) {
  return app.request(`${MOUNT}/session/${sessionId}/title`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: JSON.stringify(body),
  });
}

async function titles(app: Hono<HttpEnv>, userId = 'user-1') {
  const response = await app.request(`${MOUNT}/history`, {
    headers: { 'x-user-id': userId },
  });
  assert.equal(response.status, 200);
  return historySchema
    .parse(await response.json())
    .map(({ chatId, title }) => ({ chatId, title }));
}

async function errorCode(response: Response) {
  return {
    status: response.status,
    code: errorBodySchema.parse(await response.json()).cause.code,
  };
}

test('POST /session/:sessionId/title renames the session with 204 for its owner, answers 400 for an empty title, 404 for another user or an unknown session, and 405 for other methods', async (t) => {
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'clerk',
      model: new MockLanguageModelV4({
        doStream: async () => textResult('Done.'),
      }),
      sandbox: buildSandbox(),
      instructions: [],
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();
  const app = new Hono<HttpEnv>();
  app.use(`${MOUNT}/*`, (context, next) => {
    context.set('userId', context.req.header('x-user-id') ?? 'user-1');
    return next();
  });
  app.route(MOUNT, http(host));
  const sessionId = randomUUID();
  const started = await app.request(`${MOUNT}/session/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: {
        id: `message-${randomUUID()}`,
        role: 'user',
        parts: [{ type: 'text', text: 'Renew my passport' }],
      },
      trigger: 'submit-message',
    }),
  });
  assert.equal(started.status, 202);
  const { turnId } = acceptedBodySchema.parse(await started.json());
  await waitFor(
    async () =>
      assert.equal(
        (
          await host
            .observe({ chatId: sessionId, userId: 'user-1' })
            .status(turnId)
        )?.status,
        'completed',
      ),
    { interval: 50, signal: t.signal },
  );

  const renamed = await setTitle(app, sessionId, { title: '  Trip to Amman ' });
  assert.equal(renamed.status, 204);
  assert.equal(renamed.headers.get('cache-control'), 'no-store');
  assert.equal(await renamed.text(), '');

  assert.deepStrictEqual(
    await errorCode(await setTitle(app, sessionId, { title: '   ' })),
    { status: 400, code: 'zukhruf/session-title-empty' },
  );
  assert.equal((await setTitle(app, sessionId, {})).status, 400);
  assert.deepStrictEqual(
    await errorCode(
      await setTitle(app, sessionId, { title: 'Mine' }, 'intruder'),
    ),
    { status: 404, code: 'zukhruf/session-not-found' },
  );
  assert.deepStrictEqual(
    await errorCode(await setTitle(app, randomUUID(), { title: 'Mine' })),
    { status: 404, code: 'zukhruf/session-not-found' },
  );
  const wrongMethod = await app.request(`${MOUNT}/session/${sessionId}/title`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');

  assert.deepStrictEqual(await titles(app), [
    { chatId: sessionId, title: 'Trip to Amman' },
  ]);
});
