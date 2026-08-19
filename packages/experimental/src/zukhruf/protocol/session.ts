import { createUIMessageStreamResponse } from 'ai';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { v5 as uuidv5, validate as validateUuid } from 'uuid';
import z from 'zod';

import type { ConversationId } from '../mailbox/types.ts';
import type {
  AgentObservation,
  AgentRuntime,
} from '../runtime/agent-runtime.ts';
import { validate } from './validator.ts';

export const ZUKHRUF_ROUTE_PREFIX = '/zukhruf/v1';
const CREATE_SESSION_ROUTE_PATH = '/session';
const SESSION_ROUTE_PATH = '/session/:sessionId';
const SESSION_CANCEL_ROUTE_PATH = '/session/:sessionId/cancel';
const SESSION_STREAM_ROUTE_PATH = '/session/:sessionId/stream';
const SESSION_TURN_ROUTE_PATH = '/session/:sessionId/turn/:turnId';
const SESSION_TURN_CANCEL_ROUTE_PATH =
  '/session/:sessionId/turn/:turnId/cancel';
const INFO_ROUTE_PATH = '/info';
const HEALTH_ROUTE_PATH = '/health';
export const ZUKHRUF_CREATE_SESSION_ROUTE_PATH = `${ZUKHRUF_ROUTE_PREFIX}${CREATE_SESSION_ROUTE_PATH}`;
export const ZUKHRUF_SESSION_ROUTE_PATH = `${ZUKHRUF_ROUTE_PREFIX}${SESSION_ROUTE_PATH}`;
export const ZUKHRUF_SESSION_CANCEL_ROUTE_PATH = `${ZUKHRUF_ROUTE_PREFIX}${SESSION_CANCEL_ROUTE_PATH}`;
export const ZUKHRUF_SESSION_STREAM_ROUTE_PATH = `${ZUKHRUF_ROUTE_PREFIX}${SESSION_STREAM_ROUTE_PATH}`;
export const ZUKHRUF_SESSION_TURN_ROUTE_PATH = `${ZUKHRUF_ROUTE_PREFIX}${SESSION_TURN_ROUTE_PATH}`;
export const ZUKHRUF_SESSION_TURN_CANCEL_ROUTE_PATH = `${ZUKHRUF_ROUTE_PREFIX}${SESSION_TURN_CANCEL_ROUTE_PATH}`;
export const ZUKHRUF_INFO_ROUTE_PATH = `${ZUKHRUF_ROUTE_PREFIX}${INFO_ROUTE_PATH}`;
export const ZUKHRUF_HEALTH_ROUTE_PATH = `${ZUKHRUF_ROUTE_PREFIX}${HEALTH_ROUTE_PATH}`;
export const ZUKHRUF_SESSION_ID_HEADER = 'x-zukhruf-session-id';
export const ZUKHRUF_TURN_ID_HEADER = 'x-zukhruf-turn-id';

const MAX_BODY_BYTES = 10 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_INPUT_LENGTH = 8_000;
const SESSION_NAMESPACE = uuidv5('urn:deepagents:zukhruf:sessions', uuidv5.URL);
const NO_STORE = { 'cache-control': 'no-store' } as const;
const sessionIdSchema = z.string().refine(validateUuid);
const turnBodySchema = z.strictObject({
  input: z.string().trim().min(1).max(MAX_INPUT_LENGTH),
});
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_IDEMPOTENCY_KEY_LENGTH);
const limitTurnBody = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: () => {
    throw new HTTPException(413, {
      message: 'Request body is too large',
      cause: {
        code: 'api/payload-too-large',
        detail: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
      },
    });
  },
});

interface ZukhrufRuntime extends Pick<
  AgentRuntime,
  'createSession' | 'enqueue' | 'info' | 'sessionExists'
> {
  observe(
    conversation: ConversationId,
  ): Pick<AgentObservation, 'cancel' | 'resume' | 'status'>;
}

type ZukhrufEnv = { Variables: { userId: string } };

/** Mount with `app.route(ZUKHRUF_ROUTE_PREFIX, zukhruf(runtime))`. */
export function zukhruf(runtime: ZukhrufRuntime) {
  const app = new Hono<ZukhrufEnv>();
  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json(
        { cause: error.cause, error: error.message },
        error.status,
        NO_STORE,
      );
    }
    throw error;
  });

  app.on(['GET', 'HEAD'], HEALTH_ROUTE_PATH, (context) =>
    context.req.method === 'HEAD'
      ? context.body(null, 200, NO_STORE)
      : context.json({ ok: true }, 200, NO_STORE),
  );
  app.all(HEALTH_ROUTE_PATH, (context) =>
    methodNotAllowed(context, 'GET, HEAD'),
  );

  app.use('*', async (context, next) => {
    if (!context.get('userId')?.trim()) {
      throw new HTTPException(401, {
        message: 'Authentication required',
        cause: {
          code: 'api/unauthenticated',
          detail: 'Authentication required to access Zukhruf',
        },
      });
    }
    await next();
  });

  app.get(INFO_ROUTE_PATH, (context) =>
    context.json(runtime.info, 200, NO_STORE),
  );
  app.all(INFO_ROUTE_PATH, (context) => methodNotAllowed(context, 'GET'));

  app.post(
    CREATE_SESSION_ROUTE_PATH,
    limitTurnBody,
    validate('application/json', (payload) => ({
      body: {
        select: payload.body,
        against: turnBodySchema,
      },
      idempotencyKey: {
        select: payload.headers['idempotency-key'],
        against: idempotencyKeySchema,
      },
    })),
    async (context) => {
      const { body, idempotencyKey } = context.var.input;
      const userId = context.get('userId');
      const sessionId = uuidv5(
        JSON.stringify([userId, idempotencyKey]),
        SESSION_NAMESPACE,
      );
      const conversation = { chatId: sessionId, userId };
      await runtime.createSession(conversation);
      const turn = await runtime.enqueue(conversation, {
        id: idempotencyKey,
        input: body.input.trim(),
      });

      return accepted(context, sessionId, turn.id);
    },
  );
  app.all(CREATE_SESSION_ROUTE_PATH, (context) =>
    methodNotAllowed(context, 'POST'),
  );

  app.post(
    SESSION_ROUTE_PATH,
    limitTurnBody,
    validate('application/json', (payload) => ({
      body: {
        select: payload.body,
        against: turnBodySchema,
      },
      idempotencyKey: {
        select: payload.headers['idempotency-key'],
        against: idempotencyKeySchema,
      },
      sessionId: {
        select: payload.params.sessionId,
        against: sessionIdSchema,
      },
    })),
    async (context) => {
      const { body, idempotencyKey, sessionId } = context.var.input;
      const conversation = {
        chatId: sessionId,
        userId: context.get('userId'),
      };
      await requireSession(runtime, conversation);
      const turn = await runtime.enqueue(conversation, {
        id: idempotencyKey,
        input: body.input.trim(),
      });

      return accepted(context, sessionId, turn.id);
    },
  );
  app.all(SESSION_ROUTE_PATH, (context) => methodNotAllowed(context, 'POST'));

  app.get(
    SESSION_TURN_ROUTE_PATH,
    validate((payload) => ({
      sessionId: {
        select: payload.params.sessionId,
        against: sessionIdSchema,
      },
      turnId: {
        select: payload.params.turnId,
        against: sessionIdSchema,
      },
    })),
    async (context) => {
      const { sessionId, turnId } = context.var.input;
      const conversation = {
        chatId: sessionId,
        userId: context.get('userId'),
      };
      await requireSession(runtime, conversation);
      const status = await runtime.observe(conversation).status(turnId);
      if (!status) {
        throw new HTTPException(404, {
          message: 'Session turn not found',
          cause: {
            code: 'zukhruf/session-turn-not-found',
            detail: `Turn ${turnId} does not exist in session ${sessionId}`,
          },
        });
      }
      return context.json({ sessionId, turnId, ...status }, 200, NO_STORE);
    },
  );
  app.all(SESSION_TURN_ROUTE_PATH, (context) =>
    methodNotAllowed(context, 'GET'),
  );

  app.post(
    SESSION_TURN_CANCEL_ROUTE_PATH,
    validate((payload) => ({
      sessionId: {
        select: payload.params.sessionId,
        against: sessionIdSchema,
      },
      turnId: {
        select: payload.params.turnId,
        against: sessionIdSchema,
      },
    })),
    async (context) => {
      const { sessionId, turnId } = context.var.input;
      const conversation = {
        chatId: sessionId,
        userId: context.get('userId'),
      };
      await requireSession(runtime, conversation);
      await runtime.observe(conversation).cancel(turnId);
      return context.body(null, 204, NO_STORE);
    },
  );
  app.all(SESSION_TURN_CANCEL_ROUTE_PATH, (context) =>
    methodNotAllowed(context, 'POST'),
  );

  app.post(
    SESSION_CANCEL_ROUTE_PATH,
    validate((payload) => ({
      sessionId: {
        select: payload.params.sessionId,
        against: sessionIdSchema,
      },
    })),
    async (context) => {
      const { sessionId } = context.var.input;
      const conversation = {
        chatId: sessionId,
        userId: context.get('userId'),
      };
      await requireSession(runtime, conversation);
      await runtime.observe(conversation).cancel();
      return context.body(null, 204, NO_STORE);
    },
  );
  app.all(SESSION_CANCEL_ROUTE_PATH, (context) =>
    methodNotAllowed(context, 'POST'),
  );

  app.get(
    SESSION_STREAM_ROUTE_PATH,
    validate((payload) => ({
      sessionId: {
        select: payload.params.sessionId,
        against: sessionIdSchema,
      },
    })),
    async (context) => {
      const { sessionId } = context.var.input;
      const conversation = {
        chatId: sessionId,
        userId: context.get('userId'),
      };
      await requireSession(runtime, conversation);
      const stream = await runtime.observe(conversation).resume();
      if (!stream) {
        throw new HTTPException(404, {
          message: 'Session stream not found',
          cause: {
            code: 'zukhruf/session-stream-not-found',
            detail: `No durable stream exists for session ${sessionId}`,
          },
        });
      }

      return createUIMessageStreamResponse({
        headers: NO_STORE,
        stream,
      });
    },
  );
  app.all(SESSION_STREAM_ROUTE_PATH, (context) =>
    methodNotAllowed(context, 'GET'),
  );

  return app;
}

function accepted<Env extends ZukhrufEnv>(
  context: Context<Env>,
  sessionId: string,
  turnId: string,
) {
  return context.json({ ok: true, sessionId, turnId }, 202, {
    ...NO_STORE,
    [ZUKHRUF_SESSION_ID_HEADER]: sessionId,
    [ZUKHRUF_TURN_ID_HEADER]: turnId,
  });
}

async function requireSession(
  runtime: ZukhrufRuntime,
  conversation: ConversationId,
): Promise<void> {
  if (await runtime.sessionExists(conversation)) return;
  throw new HTTPException(404, {
    message: 'Session not found',
    cause: {
      code: 'zukhruf/session-not-found',
      detail: `Session ${conversation.chatId} does not exist`,
    },
  });
}

function methodNotAllowed(context: Context<ZukhrufEnv>, allow: string): never {
  context.header('Allow', allow);
  throw new HTTPException(405, {
    message: 'Method not allowed',
    cause: {
      code: 'api/method-not-allowed',
      detail: `This endpoint only accepts ${allow} requests`,
    },
  });
}
