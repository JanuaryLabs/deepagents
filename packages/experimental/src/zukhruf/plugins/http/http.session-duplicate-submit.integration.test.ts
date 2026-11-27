import { PGlite } from '@electric-sql/pglite';
import { TemporaryFiles } from '@zukhruf/fs';
import { suite, test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import { InMemoryContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  type AgentHost,
  AgentRuntime,
  EmbeddedAgentStorage,
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

type AgentStack = ReturnType<typeof defineStack>;

const MOUNT = '/zukhruf/v1';

const acceptedBodySchema = z.looseObject({ turnId: z.string() });

const embedded = (resources: AsyncDisposableStack) =>
  defineStack(async () => {
    const directory = resources.use(
      await new TemporaryFiles().directory('zukhruf-'),
    );
    return {
      storage: resources.use(
        await EmbeddedAgentStorage.open({ directory: directory.path }),
      ),
    };
  });

const pgBossOnPglite = () =>
  defineStack(async (resources) => {
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

const variants: Record<
  string,
  (resources: AsyncDisposableStack) => AgentStack
> = {
  'embedded storage (SQLite outbox)': embedded,
  'pg-boss on PGlite': () => pgBossOnPglite(),
};

function lastUserText(
  prompt: MockLanguageModelV4['doStreamCalls'][number]['prompt'],
) {
  const last = prompt.findLast((message) => message.role === 'user');
  return (
    last?.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('') ?? ''
  );
}

async function serve(
  resources: AsyncDisposableStack,
  stack: AgentStack,
  model: MockLanguageModelV4,
) {
  const runtime = resources.use(
    await new AgentRuntime(
      defineAgent({
        name: 'root',
        instructions: [],
        model,
        sandbox: buildSandbox(),
      }),
    ).initialize(stack),
  );
  const worker = resources.use(await runtime.work());
  const app = new Hono<HttpEnv>();
  app.use(`${MOUNT}/*`, (context, next) => {
    context.set('userId', 'user-1');
    return next();
  });
  app.route(MOUNT, http(runtime));
  return { app, runtime, worker };
}

async function sessionStatus(app: Hono<HttpEnv>, sessionId: string) {
  const response = await app.request(`${MOUNT}/session/${sessionId}`);
  assert.equal(response.status, 200);
  return z.looseObject({ status: z.unknown() }).parse(await response.json())
    .status;
}

/** POSTs one user message under the given id, expects 202 and answers its turn id. */
async function submit(
  app: Hono<HttpEnv>,
  sessionId: string,
  messageId: string,
  text: string,
) {
  const response = await app.request(`${MOUNT}/session/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: { id: messageId, role: 'user', parts: [{ type: 'text', text }] },
      trigger: 'submit-message',
    }),
  });
  assert.equal(response.status, 202);
  return acceptedBodySchema.parse(await response.json()).turnId;
}

function settled(
  runtime: AgentHost,
  sessionId: string,
  turnId: string,
  status: string,
  signal: AbortSignal,
) {
  return waitFor(
    async () =>
      assert.equal(
        (
          await runtime
            .observe({ chatId: sessionId, userId: 'user-1' })
            .status(turnId)
        )?.status,
        status,
      ),
    { interval: 50, signal },
  );
}

async function chain(runtime: AgentHost, sessionId: string) {
  const messages = await runtime
    .observe({ chatId: sessionId, userId: 'user-1' })
    .engine.getMessages();
  return messages.map(({ role, parts }) => ({
    role,
    text: parts.map((part) => ('text' in part ? part.text : '')).join(''),
  }));
}

/**
 * Sends a sentinel question after the duplicate and waits until it completes.
 * Turns of one chat run in order, so any job the duplicate queued has run by
 * then.
 */
async function drain(
  app: Hono<HttpEnv>,
  runtime: AgentHost,
  sessionId: string,
  signal: AbortSignal,
) {
  const sentinel = await submit(
    app,
    sessionId,
    `message-${randomUUID()}`,
    'sentinel',
  );
  await settled(runtime, sessionId, sentinel, 'completed', signal);
}

void suite.each(Object.entries(variants), ([name, stackFor]) =>
  suite(`a second POST /session/:id with the same message id (${name})`, () => {
    void test('after the first turn completed runs no second turn and stores the question once', async (t) => {
      await using resources = new AsyncDisposableStack();
      const model = new MockLanguageModelV4({
        doStream: async ({ prompt }) =>
          textResult(`done:${lastUserText(prompt)}`),
      });
      const { app, runtime } = await serve(
        resources,
        stackFor(resources),
        model,
      );
      const sessionId = randomUUID();
      const messageId = `message-${randomUUID()}`;

      const first = await submit(app, sessionId, messageId, 'question');
      await settled(runtime, sessionId, first, 'completed', t.signal);
      const retry = await submit(app, sessionId, messageId, 'question');
      await drain(app, runtime, sessionId, t.signal);

      assert.deepStrictEqual(
        {
          retry,
          questionCalls: model.doStreamCalls.filter(
            ({ prompt }) => lastUserText(prompt) === 'question',
          ).length,
          chain: await chain(runtime, sessionId),
        },
        {
          retry: first,
          questionCalls: 1,
          chain: [
            { role: 'user', text: 'question' },
            { role: 'assistant', text: 'done:question' },
            { role: 'user', text: 'sentinel' },
            { role: 'assistant', text: 'done:sentinel' },
          ],
        },
      );
    });

    void test('after the first turn completed leaves the session idle with no worker running', async (t) => {
      await using resources = new AsyncDisposableStack();
      const model = new MockLanguageModelV4({
        doStream: async ({ prompt }) =>
          textResult(`done:${lastUserText(prompt)}`),
      });
      const { app, runtime, worker } = await serve(
        resources,
        stackFor(resources),
        model,
      );
      const sessionId = randomUUID();
      const messageId = `message-${randomUUID()}`;
      const first = await submit(app, sessionId, messageId, 'question');
      await settled(runtime, sessionId, first, 'completed', t.signal);
      await worker[Symbol.asyncDispose]();

      const retry = await submit(app, sessionId, messageId, 'question');

      assert.deepStrictEqual(
        { retry, status: await sessionStatus(app, sessionId) },
        { retry: first, status: { type: 'idle' } },
      );
    });

    void test('while the first turn is still running runs no second turn and stores the question once', async (t) => {
      await using resources = new AsyncDisposableStack();
      const release = Promise.withResolvers<void>();
      const model = new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          const text = lastUserText(prompt);
          if (text === 'question') await release.promise;
          return textResult(`done:${text}`);
        },
      });
      const { app, runtime } = await serve(
        resources,
        stackFor(resources),
        model,
      );
      const sessionId = randomUUID();
      const messageId = `message-${randomUUID()}`;

      const first = await submit(app, sessionId, messageId, 'question');
      await waitFor(() => assert.equal(model.doStreamCalls.length, 1), {
        interval: 20,
        signal: t.signal,
      });
      const retry = await submit(app, sessionId, messageId, 'question');
      release.resolve();
      await settled(runtime, sessionId, first, 'completed', t.signal);
      await drain(app, runtime, sessionId, t.signal);

      assert.deepStrictEqual(
        {
          retry,
          questionCalls: model.doStreamCalls.filter(
            ({ prompt }) => lastUserText(prompt) === 'question',
          ).length,
          chain: await chain(runtime, sessionId),
        },
        {
          retry: first,
          questionCalls: 1,
          chain: [
            { role: 'user', text: 'question' },
            { role: 'assistant', text: 'done:question' },
            { role: 'user', text: 'sentinel' },
            { role: 'assistant', text: 'done:sentinel' },
          ],
        },
      );
    });
  }),
);
