import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  turns: z
    .array(
      z.looseObject({
        turnId: z.string(),
        status: z.string(),
        messageIds: z.array(z.string()),
      }),
    )
    .optional(),
  status: z.looseObject({ type: z.string() }),
  archivedAt: z.number().optional(),
});
const storedKindSchema = z.looseObject({
  zukhruf: z.looseObject({ contentKind: z.string() }),
});
const uiChunkSchema = z.looseObject({
  type: z.string(),
  delta: z.string().optional(),
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

async function startTurn(app: Hono<HttpEnv>, sessionId: string, text: string) {
  const response = await app.request(`${MOUNT}/session/${sessionId}`, {
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
  assert.equal(response.status, 202);
  return acceptedBodySchema.parse(await response.json()).turnId;
}

function post(app: Hono<HttpEnv>, path: string) {
  return app.request(`${MOUNT}${path}`, { method: 'POST' });
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

/** Reads the session's live UI stream until its text deltas hold `text`. */
async function streamed(app: Hono<HttpEnv>, sessionId: string, text: string) {
  const response = await app.request(`${MOUNT}/session/${sessionId}/stream`);
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let deltas = '';
  try {
    while (!deltas.includes(text)) {
      const { done, value } = await reader.read();
      assert.equal(done, false, `stream ended with ${deltas}`);
      buffer += value;
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        const data = event.replace(/^data: /, '');
        if (data === '[DONE]') continue;
        const chunk = uiChunkSchema.parse(JSON.parse(data));
        if (chunk.type === 'text-delta') deltas += chunk.delta ?? '';
      }
    }
  } finally {
    await reader.cancel();
  }
}

/**
 * GET /session/:id as role + text of each message, each turn's status with
 * the texts of the messages it lists, and whether the session is archived.
 */
async function readSession(app: Hono<HttpEnv>, sessionId: string) {
  const response = await app.request(`${MOUNT}/session/${sessionId}`);
  assert.equal(response.status, 200);
  const { messages, turns, archivedAt } = sessionSchema.parse(
    await response.json(),
  );
  const texts = new Map(
    messages.map(({ id, parts }) => [
      id,
      parts.map((part) => part.text ?? '').join(''),
    ]),
  );
  return {
    messages: messages.map(({ id, role }) => ({ role, text: texts.get(id) })),
    turns: turns?.map(({ turnId, status, messageIds }) => ({
      turnId,
      status,
      texts: messageIds.map((id) => texts.get(id)),
    })),
    archived: archivedAt !== undefined,
  };
}

/** The stored chain as each message's role and model-only content kind. */
async function storedKinds(runtime: AgentHost, sessionId: string) {
  const messages = await runtime
    .observe({ chatId: sessionId, userId: 'user-1' })
    .engine.getMessages();
  return messages.map(({ role, metadata }) => ({
    role,
    kind: storedKindSchema.safeParse(metadata).data?.zukhruf.contentKind,
  }));
}

/** GET /session/:id's session status. */
async function sessionStatus(app: Hono<HttpEnv>, sessionId: string) {
  const response = await app.request(`${MOUNT}/session/${sessionId}`);
  assert.equal(response.status, 200);
  return sessionSchema.parse(await response.json()).status.type;
}

function userTexts(prompt: LanguageModelV4Prompt) {
  return prompt.flatMap((message) =>
    message.role === 'user'
      ? [
          message.content
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join(''),
        ]
      : [],
  );
}

function lastUserText(prompt: LanguageModelV4Prompt) {
  return userTexts(prompt).at(-1) ?? '';
}

/** Waits until the turn is neither queued nor running. */
function turnEnded(
  runtime: AgentHost,
  sessionId: string,
  turnId: string,
  signal: AbortSignal,
) {
  return waitFor(
    async () => {
      const status = (
        await runtime
          .observe({ chatId: sessionId, userId: 'user-1' })
          .status(turnId)
      )?.status;
      assert.ok(
        status !== undefined && !['queued', 'running'].includes(status),
        `turn ${status}`,
      );
    },
    { signal },
  );
}

function answering() {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => textResult(`done:${lastUserText(prompt)}`),
  });
}

/**
 * Streams "partial answer ", then holds the call open until it is aborted.
 * The trailing space lets the runtime's word smoothing release the last word
 * before the abort.
 */
function partialThenHold() {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 'text-1' });
          controller.enqueue({
            type: 'text-delta',
            id: 'text-1',
            delta: 'partial answer ',
          });
          abortSignal?.addEventListener(
            'abort',
            () => controller.error(abortSignal.reason),
            { once: true },
          );
        },
      }),
    }),
  });
}

void test.each(
  [
    { name: 'POST /session/:id/archive', path: 'archive', archived: true },
    {
      name: 'POST /session/:id/cancel (Stop)',
      path: 'cancel',
      archived: false,
    },
  ],
  (stop) =>
    test(`${stop.name} while a turn is running: GET /session/:id keeps the question and the partial answer, shows no <turn_aborted> user message, and reports the turn as interrupted`, async (t) => {
      await using resources = new AsyncDisposableStack();
      const { app, runtime } = await serve(resources, partialThenHold());
      resources.use(await runtime.work());
      const sessionId = randomUUID();
      const turnId = await startTurn(app, sessionId, QUESTION);
      await turnStatus(runtime, sessionId, turnId, 'running', t.signal);
      await streamed(app, sessionId, 'partial answer ');

      const stopped = (await post(app, `/session/${sessionId}/${stop.path}`))
        .status;
      await turnStatus(runtime, sessionId, turnId, 'cancelled', t.signal);

      assert.deepStrictEqual(
        { stopped, session: await readSession(app, sessionId) },
        {
          stopped: 204,
          session: {
            messages: [
              { role: 'user', text: QUESTION },
              { role: 'assistant', text: 'partial answer ' },
            ],
            turns: [
              {
                turnId,
                status: 'interrupted',
                texts: [QUESTION, 'partial answer '],
              },
            ],
            archived: stop.archived,
          },
        },
      );
    }),
);

void test('a turn queued behind a running answer and cancelled before it starts is dropped: neither the stored chain nor the next turn prompt holds its text (#5800)', async (t) => {
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
  const running = await startTurn(app, sessionId, 'hold');
  await turnStatus(runtime, sessionId, running, 'running', t.signal);
  const queued = await startTurn(app, sessionId, 'withdrawn question');

  const cancelled = (
    await post(app, `/session/${sessionId}/turn/${queued}/cancel`)
  ).status;
  await turnStatus(runtime, sessionId, queued, 'cancelled', t.signal);
  release.resolve();
  await turnStatus(runtime, sessionId, running, 'completed', t.signal);
  const next = await startTurn(app, sessionId, 'next');
  await turnStatus(runtime, sessionId, next, 'completed', t.signal);

  const session = await readSession(app, sessionId);
  assert.deepStrictEqual(
    {
      cancelled,
      stored: session.messages,
      turns: session.turns,
      status: await sessionStatus(app, sessionId),
      nextPrompt: userTexts(model.doStreamCalls.at(-1)?.prompt ?? []),
      modelCalls: model.doStreamCalls.map(({ prompt }) => lastUserText(prompt)),
    },
    {
      cancelled: 204,
      stored: [
        { role: 'user', text: 'hold' },
        { role: 'assistant', text: 'done:hold' },
        { role: 'user', text: 'next' },
        { role: 'assistant', text: 'done:next' },
      ],
      turns: [
        { turnId: running, status: 'completed', texts: ['hold', 'done:hold'] },
        { turnId: next, status: 'completed', texts: ['next', 'done:next'] },
      ],
      status: 'idle',
      nextPrompt: ['hold', 'next'],
      modelCalls: ['hold', 'next'],
    },
  );
});

void test('POST /session/:id/archive while a lone first question is still queued stores the question, reports the turn as interrupted, and the model is never called for it after POST /session/:id/unarchive', async (t) => {
  await using resources = new AsyncDisposableStack();
  const model = answering();
  const { app, runtime } = await serve(resources, model);
  const sessionId = randomUUID();
  const turnId = await startTurn(app, sessionId, QUESTION);

  const archived = (await post(app, `/session/${sessionId}/archive`)).status;
  const whileArchived = await readSession(app, sessionId);
  resources.use(await runtime.work());
  const unarchived = (await post(app, `/session/${sessionId}/unarchive`))
    .status;
  const next = await startTurn(app, sessionId, 'next');
  await turnStatus(runtime, sessionId, next, 'completed', t.signal);

  assert.deepStrictEqual(
    {
      archived,
      whileArchived,
      unarchived,
      modelCalls: model.doStreamCalls.map(({ prompt }) => lastUserText(prompt)),
    },
    {
      archived: 204,
      whileArchived: {
        messages: [{ role: 'user', text: QUESTION }],
        turns: [{ turnId, status: 'interrupted', texts: [QUESTION] }],
        archived: true,
      },
      unarchived: 200,
      modelCalls: ['next'],
    },
  );
});

void test('POST /session/:id/cancel while a lone first question is still queued stores the question and reports the turn as interrupted', async (t) => {
  await using resources = new AsyncDisposableStack();
  const model = answering();
  const { app, runtime } = await serve(resources, model);
  const sessionId = randomUUID();
  const turnId = await startTurn(app, sessionId, QUESTION);

  const cancelled = (await post(app, `/session/${sessionId}/cancel`)).status;
  resources.use(await runtime.work());
  await turnEnded(runtime, sessionId, turnId, t.signal);

  assert.deepStrictEqual(
    {
      cancelled,
      session: await readSession(app, sessionId),
      modelCalls: model.doStreamCalls.length,
    },
    {
      cancelled: 204,
      session: {
        messages: [{ role: 'user', text: QUESTION }],
        turns: [{ turnId, status: 'interrupted', texts: [QUESTION] }],
        archived: false,
      },
      modelCalls: 0,
    },
  );
});

void test('POST /session/:id/archive while a worker holds the first turn in its sandbox setup stores the question, reports the turn as interrupted, and the model is never called', async (t) => {
  await using resources = new AsyncDisposableStack();
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const model = answering();
  const { app, runtime } = await serve(
    resources,
    model,
    new VirtualSandboxEnvironment({
      readiness: async () => {
        entered.resolve();
        await ready.promise;
      },
    }),
  );
  resources.use(await runtime.work());
  const sessionId = randomUUID();
  const turnId = await startTurn(app, sessionId, QUESTION);
  await entered.promise;

  let answered = false;
  const archiving = (async () => {
    const response = await post(app, `/session/${sessionId}/archive`);
    answered = true;
    return response.status;
  })();
  // Setup ends once the archive has cancelled the turn, or has answered
  // without cancelling it.
  await waitFor(
    async () => {
      if (answered) return;
      assert.equal(
        (
          await runtime
            .observe({ chatId: sessionId, userId: 'user-1' })
            .status(turnId)
        )?.status,
        'cancelled',
      );
    },
    { signal: t.signal },
  );
  ready.resolve();
  const archived = await archiving;
  await turnEnded(runtime, sessionId, turnId, t.signal);

  assert.deepStrictEqual(
    {
      archived,
      session: await readSession(app, sessionId),
      chain: await storedKinds(runtime, sessionId),
      modelCalls: model.doStreamCalls.length,
    },
    {
      archived: 204,
      session: {
        messages: [{ role: 'user', text: QUESTION }],
        turns: [{ turnId, status: 'interrupted', texts: [QUESTION] }],
        archived: true,
      },
      chain: [
        { role: 'user', kind: undefined },
        { role: 'user', kind: 'generic.turn_aborted' },
      ],
      modelCalls: 0,
    },
  );
});
