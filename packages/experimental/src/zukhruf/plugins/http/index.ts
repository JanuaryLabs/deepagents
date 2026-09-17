import {
  type JSONSchema7,
  type UIMessage,
  createUIMessageStreamResponse,
  safeValidateUIMessages,
} from 'ai';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { basePath } from 'hono/route';
import { streamSSE } from 'hono/streaming';
import { validate as validateUuid } from 'uuid';
import z from 'zod';

import { elementsSchema } from '@deepagents/elements';

import type { ConversationId } from '../../mailbox/types.ts';
import type {
  AgentHost,
  AgentObservation,
  AgentPluginDefinition,
  AgentPluginInstance,
} from '../../runtime/agent-runtime.ts';
import { validate } from './validator.ts';

export type HttpEnv = { Variables: { userId: string } };

export type OwnerEvent =
  | { readonly type: 'ready' }
  | {
      readonly type: 'change';
      readonly resource: string;
      readonly id: string;
      readonly [key: string]: unknown;
    };

type OwnerEventNotification =
  Exclude<OwnerEvent, { type: 'ready' }> | { readonly type: 'reset' };

export type OwnerEventSource = (
  userId: string,
  signal: AbortSignal,
) => Promise<AsyncIterable<OwnerEventNotification>>;

/** A discoverable feature: its route under the mount plus any detail the client needs to use it. */
export interface HttpCapability {
  readonly path: string;
  readonly [detail: string]: unknown;
}

export interface HttpContribution {
  readonly capabilities: Readonly<Record<string, HttpCapability>>;
  readonly publicRoutes?: Hono<HttpEnv>;
  readonly authenticatedRoutes?: Hono<HttpEnv>;
  readonly events?: OwnerEventSource;
}

export interface HttpProjection {
  project(runtime: HttpRuntime): HttpContribution;
}

export function projectHttp<Instance extends object>(
  definition: AgentPluginDefinition<Instance>,
  project: (
    plugin: AgentPluginInstance & Instance,
    runtime: HttpRuntime,
  ) => HttpContribution,
): HttpProjection {
  return {
    project(runtime) {
      return project(runtime.plugin(definition), runtime);
    },
  };
}

const SESSION_ROUTE_PATH = '/session/:sessionId';
const SESSION_CANCEL_ROUTE_PATH = '/session/:sessionId/cancel';
const SESSION_STREAM_ROUTE_PATH = '/session/:sessionId/stream';
const EVENTS_ROUTE_PATH = '/events';
const SESSION_TURN_ROUTE_PATH = '/session/:sessionId/turn/:turnId';
const SESSION_TURN_CANCEL_ROUTE_PATH =
  '/session/:sessionId/turn/:turnId/cancel';
const HISTORY_ROUTE_PATH = '/history';
const INFO_ROUTE_PATH = '/info';
const HEALTH_ROUTE_PATH = '/health';
export const ZUKHRUF_SESSION_ID_HEADER = 'x-zukhruf-session-id';
export const ZUKHRUF_TURN_ID_HEADER = 'x-zukhruf-turn-id';

/** Where the host mounted this API, without a trailing slash; empty at `/`. */
export function mountPath(context: Context): string {
  return basePath(context).replace(/\/$/, '');
}

const NO_STORE = { 'cache-control': 'no-store' } as const;
const sessionIdSchema = z.string().refine(validateUuid);
const jsonSchema = z.custom<JSONSchema7>(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value),
);
const clientToolsSchema = z
  .record(
    z.string().min(1),
    z.strictObject({
      inputSchema: jsonSchema,
      description: z.string().min(1),
    }),
  )
  .optional();
const turnBodySchema = z.strictObject({
  sessionId: sessionIdSchema,
  message: z.unknown(),
  trigger: z.enum(['submit-message', 'regenerate-message']),
  tools: clientToolsSchema,
  elements: elementsSchema,
});

export interface HttpRuntime extends Pick<
  AgentHost,
  | 'createSession'
  | 'enqueue'
  | 'info'
  | 'listHistory'
  | 'plugin'
  | 'sessionExists'
  | 'subscribeConversationStatus'
> {
  observe(conversation: ConversationId): Pick<
    AgentObservation,
    'cancel' | 'resume' | 'status'
  > & {
    engine: Pick<AgentObservation['engine'], 'getMessages'>;
  };
}

/** Mount at the host-selected path with `app.route(path, http(runtime))`. */
export function http(
  runtime: HttpRuntime,
  ...projections: readonly HttpProjection[]
) {
  const contributions = projections.map((projection) =>
    projection.project(runtime),
  );
  const capabilities: Record<string, HttpCapability> = {
    history: { path: HISTORY_ROUTE_PATH },
    chat: { path: '/session' },
    events: { path: EVENTS_ROUTE_PATH },
  };
  for (const { capabilities: contributed } of contributions) {
    for (const [name, capability] of Object.entries(contributed)) {
      if (!name.trim() || name !== name.trim()) {
        throw new Error(
          `http: capability name "${name}" must be non-empty without surrounding whitespace`,
        );
      }
      if (!capability.path.startsWith('/')) {
        throw new Error(`http: capability "${name}" must use an absolute path`);
      }
      if (Object.hasOwn(capabilities, name)) {
        throw new Error(`http: duplicate capability "${name}"`);
      }
      capabilities[name] = capability;
    }
  }
  const app = new Hono<HttpEnv>();
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

  for (const { publicRoutes } of contributions) {
    if (publicRoutes) app.route('/', publicRoutes);
  }

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

  app.get(INFO_ROUTE_PATH, (context) => {
    const mount = mountPath(context);
    return context.json(
      {
        ...runtime.info,
        capabilities: Object.fromEntries(
          Object.entries(capabilities).map(([name, { path, ...detail }]) => [
            name,
            { href: `${mount}${path}`, ...detail },
          ]),
        ),
      },
      200,
      NO_STORE,
    );
  });
  app.all(INFO_ROUTE_PATH, (context) => methodNotAllowed(context, 'GET'));

  app.get(HISTORY_ROUTE_PATH, async (context) =>
    context.json(
      await runtime.listHistory(context.get('userId')),
      200,
      NO_STORE,
    ),
  );
  app.all(HISTORY_ROUTE_PATH, (context) => methodNotAllowed(context, 'GET'));

  app.get(
    SESSION_ROUTE_PATH,
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
      return context.json(
        {
          sessionId,
          messages: await runtime.observe(conversation).engine.getMessages(),
        },
        200,
        NO_STORE,
      );
    },
  );
  app.post(
    SESSION_ROUTE_PATH,
    validate('application/json', (payload) => ({
      body: {
        select: payload.body,
        against: turnBodySchema,
      },
      sessionId: {
        select: payload.params.sessionId,
        against: sessionIdSchema,
      },
    })),
    async (context) => {
      const { body, sessionId } = context.var.input;
      if (body.sessionId !== sessionId) {
        throw invalidSessionId('Route and body session IDs must match');
      }
      const conversation = {
        chatId: sessionId,
        userId: context.get('userId'),
      };
      const request = await validateTurnRequest(body);
      if (!(await runtime.sessionExists(conversation))) {
        if (request.message.role !== 'user') {
          throw invalidMessage('A new session must start with a user message');
        }
        if (request.trigger !== 'submit-message') {
          throw invalidMessage('A new session cannot regenerate a response');
        }
        await runtime.createSession(conversation);
      }
      const turn = await runtime.enqueue(conversation, request);

      return accepted(context, sessionId, turn.id);
    },
  );
  app.all(SESSION_ROUTE_PATH, (context) =>
    methodNotAllowed(context, 'GET, POST'),
  );

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

  const eventSources: OwnerEventSource[] = [
    async (userId, signal) => {
      const events = await runtime.subscribeConversationStatus(signal);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of events) {
            if (event.type === 'reset') {
              yield event;
            } else if (event.conversation.userId === userId) {
              yield {
                type: 'change',
                resource: 'conversation',
                id: event.conversation.chatId,
                status: event.status,
                ...(event.child ? { child: event.child } : {}),
              } satisfies OwnerEvent;
            }
          }
        },
      };
    },
    ...contributions.flatMap(({ events }) => (events ? [events] : [])),
  ];

  app.get(EVENTS_ROUTE_PATH, (context) => {
    const userId = context.get('userId');
    const abort = new AbortController();
    const requestSignal = context.req.raw.signal;
    const abortRequest = () => abort.abort();
    requestSignal.addEventListener('abort', abortRequest, { once: true });
    context.header('cache-control', 'no-store');
    return streamSSE(context, async (stream) => {
      stream.onAbort(abortRequest);
      let lastWrite: Promise<unknown> = Promise.resolve();
      const write = (event: OwnerEvent) => {
        const next = lastWrite.then(() =>
          stream.writeSSE({ data: JSON.stringify(event) }),
        );
        lastWrite = next.catch(() => {});
        return next;
      };
      const heartbeat = setInterval(() => {
        const next = lastWrite.then(async () => {
          await stream.write(': heartbeat\n\n');
        });
        lastWrite = next.catch(() => {});
      }, 15_000);
      try {
        const subscriptions = await Promise.all(
          eventSources.map((subscribe) => subscribe(userId, abort.signal)),
        );
        await write({ type: 'ready' });
        await Promise.all(
          subscriptions.map(async (events) => {
            for await (const event of events) {
              await write(event.type === 'reset' ? { type: 'ready' } : event);
            }
          }),
        );
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          throw error;
        }
      } finally {
        clearInterval(heartbeat);
        abort.abort();
        requestSignal.removeEventListener('abort', abortRequest);
      }
    });
  });
  app.all(EVENTS_ROUTE_PATH, (context) => methodNotAllowed(context, 'GET'));

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

  for (const { authenticatedRoutes } of contributions) {
    if (authenticatedRoutes) app.route('/', authenticatedRoutes);
  }

  return app;
}

function accepted<Env extends HttpEnv>(
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

async function validateTurnMessage(
  value: unknown,
): Promise<Parameters<HttpRuntime['enqueue']>[1]['message']> {
  const result = await safeValidateUIMessages({ messages: [value] });
  if (!result.success) throw invalidMessage(result.error.message);
  const message = result.data[0];
  if (!isTurnMessage(message))
    throw invalidMessage('System messages are not accepted');
  return message;
}

async function validateTurnRequest(
  body: z.infer<typeof turnBodySchema>,
): Promise<Parameters<HttpRuntime['enqueue']>[1]> {
  const message = await validateTurnMessage(body.message);
  const tools = body.tools === undefined ? {} : { tools: body.tools };
  const elements =
    body.elements === undefined ? {} : { elements: body.elements };
  if (message.role === 'assistant') {
    if (body.trigger === 'regenerate-message') {
      throw invalidMessage(
        'Regeneration requires the user message preceding the assistant response',
      );
    }
    return { message, trigger: 'submit-message', ...tools, ...elements };
  }
  return { message, trigger: body.trigger, ...tools, ...elements };
}

function isTurnMessage(
  message: UIMessage,
): message is Parameters<HttpRuntime['enqueue']>[1]['message'] {
  return message.role === 'user' || message.role === 'assistant';
}

function invalidMessage(detail: string): HTTPException {
  return new HTTPException(400, {
    message: 'Invalid message',
    cause: { code: 'api/validation-failed', detail },
  });
}

function invalidSessionId(detail: string): HTTPException {
  return new HTTPException(400, {
    message: 'Invalid session ID',
    cause: { code: 'api/validation-failed', detail },
  });
}

async function requireSession(
  runtime: HttpRuntime,
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

function methodNotAllowed(context: Context<HttpEnv>, allow: string): never {
  context.header('Allow', allow);
  throw new HTTPException(405, {
    message: 'Method not allowed',
    cause: {
      code: 'api/method-not-allowed',
      detail: `This endpoint only accepts ${allow} requests`,
    },
  });
}
