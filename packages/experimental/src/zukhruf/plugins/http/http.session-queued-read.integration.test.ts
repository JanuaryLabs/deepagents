import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { z } from 'zod';

import { VirtualSandboxEnvironment } from '@deepagents/context';
import {
  type AgentHost,
  AgentRuntime,
  EmbeddedAgentStorage,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

import { textResult } from '../../../testing/stream-results.fixture.ts';

const MOUNT = '/zukhruf/v1';
const QUESTION = 'What dose of amoxicillin for a child?';

const acceptedBodySchema = z.looseObject({ turnId: z.string() });
const sessionSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      id: z.string(),
      role: z.string(),
      parts: z.array(
        z.looseObject({ type: z.string(), text: z.string().optional() }),
      ),
    }),
  ),
  turns: z.array(
    z.looseObject({
      turnId: z.string(),
      status: z.string(),
      messageIds: z.array(z.string()),
    }),
  ),
});

async function serve(
  resources: AsyncDisposableStack,
  model: MockLanguageModelV4,
  environment = new VirtualSandboxEnvironment(),
) {
  const directory = resources.use(
    await new TemporaryFiles().directory('zukhruf-'),
  );
  const storage = resources.use(
    await EmbeddedAgentStorage.open({ directory: directory.path }),
  );
  const runtime = resources.use(
    await new AgentRuntime(
      defineAgent({
        name: 'root',
        instructions: [],
        model,
        sandbox: defineSandbox(environment),
      }),
    ).initialize(defineStack(async () => ({ storage }))),
  );
  const app = new Hono<HttpEnv>();
  app.use(`${MOUNT}/*`, (context, next) => {
    context.set('userId', 'user-1');
    return next();
  });
  app.route(MOUNT, http(runtime));
  return { app, runtime };
}

/** POSTs a question and answers its message id and turn id. */
async function ask(app: Hono<HttpEnv>, sessionId: string, text: string) {
  const messageId = `message-${randomUUID()}`;
  const response = await app.request(`${MOUNT}/session/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: {
        id: messageId,
        role: 'user',
        parts: [{ type: 'text', text }],
      },
      trigger: 'submit-message',
    }),
  });
  assert.equal(response.status, 202);
  const { turnId } = acceptedBodySchema.parse(await response.json());
  return { messageId, turnId };
}

/** GET /session/:id as each message's id, role and text, and each turn's status and message ids. */
async function readSession(app: Hono<HttpEnv>, sessionId: string) {
  const response = await app.request(`${MOUNT}/session/${sessionId}`);
  assert.equal(response.status, 200);
  const { messages, turns } = sessionSchema.parse(await response.json());
  return {
    messages: messages.map(({ id, role, parts }) => ({
      id,
      role,
      text: parts.map((part) => part.text ?? '').join(''),
    })),
    turns: turns.map(({ turnId, status, messageIds }) => ({
      turnId,
      status,
      messageIds,
    })),
  };
}

/** The stored chain as each message's id, role and text. */
async function stored(runtime: AgentHost, sessionId: string) {
  const messages = await runtime
    .observe({ chatId: sessionId, userId: 'user-1' })
    .engine.getMessages();
  return messages.map(({ id, role, parts }) => ({
    id,
    role,
    text: parts.map((part) => ('text' in part ? part.text : '')).join(''),
  }));
}

function turnStatus(
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
    { signal },
  );
}

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

function answering() {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => textResult(`done:${lastUserText(prompt)}`),
  });
}

void test('GET /session/:id while a lone first question is still queued lists the question under its in-progress turn, with the id the chain stores it under once the turn runs, and nothing is stored before then', async (t) => {
  await using resources = new AsyncDisposableStack();
  const { app, runtime } = await serve(resources, answering());
  const sessionId = randomUUID();
  const { messageId, turnId } = await ask(app, sessionId, QUESTION);

  const queued = await readSession(app, sessionId);
  const storedWhileQueued = await stored(runtime, sessionId);
  resources.use(await runtime.work());
  await turnStatus(runtime, sessionId, turnId, 'completed', t.signal);
  const answered = await readSession(app, sessionId);

  assert.deepStrictEqual(
    {
      queued,
      storedWhileQueued,
      answered: {
        messages: answered.messages.map(({ role, text }) => ({ role, text })),
        turns: answered.turns.map(({ status }) => status),
      },
      questionIds: {
        read: answered.messages[0]?.id,
        stored: (await stored(runtime, sessionId))[0]?.id,
      },
    },
    {
      queued: {
        messages: [{ id: messageId, role: 'user', text: QUESTION }],
        turns: [{ turnId, status: 'inProgress', messageIds: [messageId] }],
      },
      storedWhileQueued: [],
      answered: {
        messages: [
          { role: 'user', text: QUESTION },
          { role: 'assistant', text: `done:${QUESTION}` },
        ],
        turns: ['completed'],
      },
      questionIds: { read: messageId, stored: messageId },
    },
  );
});

void test('GET /session/:id while a worker holds the first question in its sandbox setup, before the question is stored, lists the question once under its in-progress turn', async (t) => {
  await using resources = new AsyncDisposableStack();
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const { app, runtime } = await serve(
    resources,
    answering(),
    new VirtualSandboxEnvironment({
      readiness: async () => {
        entered.resolve();
        await ready.promise;
      },
    }),
  );
  resources.use(await runtime.work());
  const sessionId = randomUUID();
  const { messageId, turnId } = await ask(app, sessionId, QUESTION);
  await entered.promise;

  const inSetup = await readSession(app, sessionId);
  const storedInSetup = await stored(runtime, sessionId);
  ready.resolve();
  await turnStatus(runtime, sessionId, turnId, 'completed', t.signal);

  assert.deepStrictEqual(
    { inSetup, storedInSetup },
    {
      inSetup: {
        messages: [{ id: messageId, role: 'user', text: QUESTION }],
        turns: [{ turnId, status: 'inProgress', messageIds: [messageId] }],
      },
      storedInSetup: [],
    },
  );
});

void test('GET /session/:id lists no question queued behind a running answer, and the chain does not hold it until its own turn runs (#5800)', async (t) => {
  await using resources = new AsyncDisposableStack();
  const release = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const text = lastUserText(prompt);
      if (text === 'hold') await release.promise;
      return textResult(`done:${text}`);
    },
  });
  const { app, runtime } = await serve(resources, model);
  resources.use(await runtime.work());
  const sessionId = randomUUID();
  const running = await ask(app, sessionId, 'hold');
  await turnStatus(runtime, sessionId, running.turnId, 'running', t.signal);
  const behind = await ask(app, sessionId, 'queued behind');

  const whileRunning = await readSession(app, sessionId);
  const storedWhileRunning = await stored(runtime, sessionId);
  release.resolve();
  await turnStatus(runtime, sessionId, behind.turnId, 'completed', t.signal);

  assert.deepStrictEqual(
    {
      whileRunning,
      storedBehind: storedWhileRunning.some(
        ({ text }) => text === 'queued behind',
      ),
      answered: (await readSession(app, sessionId)).messages.map(
        ({ role, text }) => ({ role, text }),
      ),
    },
    {
      whileRunning: {
        messages: [{ id: running.messageId, role: 'user', text: 'hold' }],
        turns: [
          {
            turnId: running.turnId,
            status: 'inProgress',
            messageIds: [running.messageId],
          },
        ],
      },
      storedBehind: false,
      answered: [
        { role: 'user', text: 'hold' },
        { role: 'assistant', text: 'done:hold' },
        { role: 'user', text: 'queued behind' },
        { role: 'assistant', text: 'done:queued behind' },
      ],
    },
  );
});
