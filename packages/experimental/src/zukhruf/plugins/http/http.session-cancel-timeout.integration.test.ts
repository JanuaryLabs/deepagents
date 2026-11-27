import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  type SandboxEnvironment,
  VirtualSandboxEnvironment,
} from '@deepagents/context';
import {
  AgentRuntime,
  EmbeddedAgentStorage,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

import { textResult } from '../../../testing/stream-results.fixture.ts';

const MOUNT = '/zukhruf/v1';
/** Codex's wait_for_thread_shutdown bound, which the cancel waits for a running turn. */
const SHUTDOWN_TIMEOUT_MS = 10_000;
const SHUTDOWN_MARGIN_MS = 5_000;

const acceptedBodySchema = z.looseObject({ turnId: z.string() });
const sessionSchema = z.looseObject({
  status: z.looseObject({ type: z.string() }),
});

/**
 * A sandbox whose listing holds the turn until `release`, deaf to the turn's
 * abort, so the turn outlives a cancel's wait; then it fails the turn.
 */
function stallingSandbox() {
  const virtual = new VirtualSandboxEnvironment();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const environment: SandboxEnvironment = {
    open: async (chat) => {
      const sandbox = await virtual.open(chat);
      return new Proxy(sandbox, {
        get: (target, property) => {
          if (property === 'listDirectory') {
            return async () => {
              entered.resolve();
              await released.promise;
              throw new Error('the sandbox failed the turn');
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    delete: (chat) => virtual.delete(chat),
  };
  return {
    environment,
    entered: entered.promise,
    release: () => released.resolve(),
  };
}

const cancelRoutes = [
  {
    route: 'POST /session/:id/cancel',
    path: (sessionId: string) => `${MOUNT}/session/${sessionId}/cancel`,
  },
  {
    route: 'POST /session/:id/turn/:turnId/cancel',
    path: (sessionId: string, turnId: string) =>
      `${MOUNT}/session/${sessionId}/turn/${turnId}/cancel`,
  },
];

void test.each(cancelRoutes, ({ route, path }) =>
  test(`${route} of a running turn that does not exit within the 10 s wait answers 202 Accepted pointing at the session, whose status stays active until the turn exits, not 204 (#6250)`, async (t) => {
    await using resources = new AsyncDisposableStack();
    const directory = resources.use(
      await new TemporaryFiles().directory('zukhruf-'),
    );
    const storage = resources.use(
      await EmbeddedAgentStorage.open({ directory: directory.path }),
    );
    const stall = stallingSandbox();
    const runtime = resources.use(
      await new AgentRuntime(
        defineAgent({
          name: 'root',
          instructions: [],
          model: new MockLanguageModelV4({
            doStream: async () => textResult('never reached'),
          }),
          sandbox: defineSandbox(stall.environment),
        }),
      ).initialize(defineStack(async () => ({ storage }))),
    );
    const app = new Hono<HttpEnv>();
    app.use(`${MOUNT}/*`, (context, next) => {
      context.set('userId', 'user-1');
      return next();
    });
    app.route(MOUNT, http(runtime));
    resources.use(await runtime.work());
    const sessionId = randomUUID();
    const conversation = { chatId: sessionId, userId: 'user-1' };
    const accepted = await app.request(`${MOUNT}/session/${sessionId}`, {
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
    assert.equal(accepted.status, 202);
    const { turnId } = acceptedBodySchema.parse(await accepted.json());
    await untilAborted(stall.entered, t.signal);

    const started = performance.now();
    const cancel = await app.request(path(sessionId, turnId), {
      method: 'POST',
    });
    const answeredAfterMs = performance.now() - started;
    const answer = {
      status: cancel.status,
      location: cancel.headers.get('location'),
      body: await cancel.text(),
    };
    const atAnswer = {
      stream: (await runtime.observe(conversation).status(turnId))?.status,
      session: sessionSchema.parse(
        await (await app.request(`${MOUNT}/session/${sessionId}`)).json(),
      ).status.type,
    };
    stall.release();
    await waitFor(
      async () =>
        assert.equal(
          sessionSchema.parse(
            await (await app.request(`${MOUNT}/session/${sessionId}`)).json(),
          ).status.type,
          'idle',
        ),
      { signal: t.signal },
    );
    const exitedAfterMs = performance.now() - started;

    assert.deepStrictEqual(
      {
        waited: answeredAfterMs >= SHUTDOWN_TIMEOUT_MS,
        bounded: answeredAfterMs < SHUTDOWN_TIMEOUT_MS + SHUTDOWN_MARGIN_MS,
        exitedAfterAnswer: exitedAfterMs > answeredAfterMs,
        atAnswer,
        status: answer.status,
        location: answer.location,
        body: answer.body && JSON.parse(answer.body),
      },
      {
        waited: true,
        bounded: true,
        exitedAfterAnswer: true,
        atAnswer: { stream: 'cancelled', session: 'active' },
        status: 202,
        location: `${MOUNT}/session/${sessionId}`,
        body: { sessionId, turnId },
      },
    );
  }),
);
