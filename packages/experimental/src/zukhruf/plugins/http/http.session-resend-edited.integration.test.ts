import { PGlite } from '@electric-sql/pglite';
import { TemporaryFiles } from '@zukhruf/fs';
import { suite, test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
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
  PostgresAgentStorage,
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

const testPostgres = new Postgres({ environment: process.env });

const postgres = () =>
  defineStack(async (resources) => {
    const database = resources.use(await testPostgres.database());
    const boss = new PgBoss({ connectionString: database.connectionString });
    boss.on('error', (error) => {
      throw error;
    });
    await boss.start();
    resources.defer(() => boss.stop({ graceful: false }));
    return {
      storage: resources.use(
        await PostgresAgentStorage.create({
          pool: database.pool(),
          boss,
          queue: { pollingIntervalSeconds: 0.5 },
        }),
      ),
    };
  });

const variants: Record<
  string,
  (resources: AsyncDisposableStack) => AgentStack
> = {
  'embedded storage (SQLite outbox)': embedded,
  'pg-boss on PGlite': () => pgBossOnPglite(),
  'Postgres storage': () => postgres(),
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
  resources.use(await runtime.work());
  const app = new Hono<HttpEnv>();
  app.use(`${MOUNT}/*`, (context, next) => {
    context.set('userId', 'user-1');
    return next();
  });
  app.route(MOUNT, http(runtime));
  return { app, runtime };
}

function post(
  app: Hono<HttpEnv>,
  sessionId: string,
  messageId: string,
  text: string,
) {
  return app.request(`${MOUNT}/session/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: { id: messageId, role: 'user', parts: [{ type: 'text', text }] },
      trigger: 'submit-message',
    }),
  });
}

async function submit(
  app: Hono<HttpEnv>,
  sessionId: string,
  messageId: string,
  text: string,
) {
  const response = await post(app, sessionId, messageId, text);
  assert.equal(response.status, 202);
  return acceptedBodySchema.parse(await response.json()).turnId;
}

async function answer(response: Response) {
  return {
    status: response.status,
    code: z
      .looseObject({ cause: z.looseObject({ code: z.string() }).optional() })
      .parse(await response.json()).cause?.code,
  };
}

function settled(
  runtime: AgentHost,
  sessionId: string,
  turnId: string,
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
        'completed',
      ),
    { interval: 50, signal },
  );
}

async function chain(runtime: AgentHost, sessionId: string) {
  const messages = await runtime
    .observe({ chatId: sessionId, userId: 'user-1' })
    .engine.getMessages();
  return messages.map(({ id, role, parts }) => ({
    id,
    role,
    text: parts.map((part) => ('text' in part ? part.text : '')).join(''),
  }));
}

/** Turns of one chat run in order, so whatever the resend queued has run once the sentinel completes. */
async function drain(
  app: Hono<HttpEnv>,
  runtime: AgentHost,
  sessionId: string,
  signal: AbortSignal,
) {
  const sentinel = await submit(app, sessionId, 'sentinel', 'sentinel');
  await settled(runtime, sessionId, sentinel, signal);
}

const refused = {
  status: 409,
  code: 'zukhruf/session-message-id-reused',
};

void suite.each(Object.entries(variants), ([name, stackFor]) =>
  suite(
    `a second POST /session/:id that reuses a message id for other text (${name})`,
    () => {
      void test('after the first turn completed is refused and leaves the first message in place', async (t) => {
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

        const first = await submit(app, sessionId, 'm1', 'a');
        await settled(runtime, sessionId, first, t.signal);
        const resend = await answer(await post(app, sessionId, 'm1', 'b'));
        await drain(app, runtime, sessionId, t.signal);

        assert.deepStrictEqual(
          {
            resend,
            prompts: model.doStreamCalls.map(({ prompt }) =>
              lastUserText(prompt),
            ),
            chain: (await chain(runtime, sessionId)).map(({ role, text }) => ({
              role,
              text,
            })),
          },
          {
            resend: refused,
            prompts: ['a', 'sentinel'],
            chain: [
              { role: 'user', text: 'a' },
              { role: 'assistant', text: 'done:a' },
              { role: 'user', text: 'sentinel' },
              { role: 'assistant', text: 'done:sentinel' },
            ],
          },
        );
      });

      void test('while the first turn is still running is refused and leaves the first message in place', async (t) => {
        await using resources = new AsyncDisposableStack();
        const release = Promise.withResolvers<void>();
        const model = new MockLanguageModelV4({
          doStream: async ({ prompt }) => {
            const text = lastUserText(prompt);
            if (text === 'a') await release.promise;
            return textResult(`done:${text}`);
          },
        });
        const { app, runtime } = await serve(
          resources,
          stackFor(resources),
          model,
        );
        const sessionId = randomUUID();

        const first = await submit(app, sessionId, 'm1', 'a');
        await waitFor(() => assert.equal(model.doStreamCalls.length, 1), {
          interval: 20,
          signal: t.signal,
        });
        const resend = await answer(await post(app, sessionId, 'm1', 'b'));
        release.resolve();
        await settled(runtime, sessionId, first, t.signal);
        await drain(app, runtime, sessionId, t.signal);

        assert.deepStrictEqual(
          {
            resend,
            prompts: model.doStreamCalls.map(({ prompt }) =>
              lastUserText(prompt),
            ),
            chain: (await chain(runtime, sessionId)).map(({ role, text }) => ({
              role,
              text,
            })),
          },
          {
            resend: refused,
            prompts: ['a', 'sentinel'],
            chain: [
              { role: 'user', text: 'a' },
              { role: 'assistant', text: 'done:a' },
              { role: 'user', text: 'sentinel' },
              { role: 'assistant', text: 'done:sentinel' },
            ],
          },
        );
      });

      void test('at the same time as the first is accepted once and refused once, and only the accepted text runs', async (t) => {
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

        const answers = await Promise.all(
          ['a', 'b'].map(async (text) => ({
            text,
            ...(await answer(await post(app, sessionId, 'm1', text))),
          })),
        );
        await drain(app, runtime, sessionId, t.signal);
        const accepted = answers.find(({ status }) => status === 202)?.text;

        assert.deepStrictEqual(
          {
            answers: answers
              .map(({ status, code }) => ({ status, code }))
              .toSorted((left, right) => left.status - right.status),
            prompts: model.doStreamCalls.map(({ prompt }) =>
              lastUserText(prompt),
            ),
          },
          {
            answers: [{ status: 202, code: undefined }, refused],
            prompts: [accepted, 'sentinel'],
          },
        );
      });
    },
  ),
);
