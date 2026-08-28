import type { Telemetry } from 'ai';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import {
  type FileTelemetryOptions,
  createFileTelemetry,
} from '@deepagents/context/telemetry/file';
import type {
  AgentPluginDefinition,
  AgentPluginHost,
  AgentPluginInstance,
  AgentPluginProtocol,
  AgentPluginToolContext,
  AgentProtocolEnv,
  ConversationId,
} from '@deepagents/experimental/zukhruf';

import {
  type AgentTraceSummary,
  FileTraceAdapter,
} from './file-trace-adapter.ts';

export * from './file-trace-adapter.ts';

const TRACES_PATH = '/traces';
const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * File telemetry integration with authenticated, conversation-scoped trace
 * reads through `zukhruf(runtime)` as the `traces` capability.
 */
export function fileTelemetry(
  options: FileTelemetryOptions,
): AgentPluginDefinition {
  const integration = createFileTelemetry(options);
  return {
    name: `file-telemetry:${integration.traces.path}`,
    create: () => new FileTelemetryPlugin(integration),
  };
}

class FileTelemetryPlugin implements AgentPluginInstance {
  readonly #adapter: FileTraceAdapter;
  readonly #integration: ReturnType<typeof createFileTelemetry>;

  constructor(integration: ReturnType<typeof createFileTelemetry>) {
    this.#adapter = new FileTraceAdapter(new URL(integration.traces.path));
    this.#integration = integration;
  }

  telemetry(context: AgentPluginToolContext): Telemetry {
    const integration = this.#integration;
    return {
      ...integration,
      onStart: (event) =>
        integration.onStart?.call(integration, { ...event, zukhruf: context }),
    };
  }

  get protocol(): AgentPluginProtocol {
    return {
      discovery: { traces: { path: TRACES_PATH } },
      routes: (host) => traceRoutes(this.#adapter, host),
    };
  }
}

function traceRoutes(adapter: FileTraceAdapter, host: AgentPluginHost) {
  const app = new Hono<AgentProtocolEnv>();
  app.get(`${TRACES_PATH}/:chatId`, async (context) => {
    const conversation = await requireConversation(host, {
      chatId: context.req.param('chatId'),
      userId: context.get('userId'),
    });
    return context.json(
      await Promise.all(
        (await adapter.list(conversation)).map((trace) =>
          withDurableStatus(host, trace),
        ),
      ),
      200,
      NO_STORE,
    );
  });
  app.get(`${TRACES_PATH}/:chatId/:traceId`, async (context) => {
    const conversation = await requireConversation(host, {
      chatId: context.req.param('chatId'),
      userId: context.get('userId'),
    });
    const traceId = context.req.param('traceId');
    const trace = await adapter.get(conversation, traceId);
    if (!trace) {
      throw new HTTPException(404, {
        message: 'Trace not found',
        cause: {
          code: 'traces/trace-not-found',
          detail: `Trace ${traceId} does not exist in conversation ${conversation.chatId}`,
        },
      });
    }
    return context.json(await withDurableStatus(host, trace), 200, NO_STORE);
  });
  return app;
}

async function requireConversation(
  host: AgentPluginHost,
  conversation: ConversationId,
): Promise<ConversationId> {
  const owned = (await host.listHistory()).some(
    (item) =>
      item.chatId === conversation.chatId &&
      item.userId === conversation.userId,
  );
  if (owned) return conversation;
  throw new HTTPException(404, {
    message: 'Conversation not found',
    cause: {
      code: 'traces/conversation-not-found',
      detail: `Conversation ${conversation.chatId} does not exist`,
    },
  });
}

async function withDurableStatus<Trace extends AgentTraceSummary>(
  host: AgentPluginHost,
  trace: Trace,
): Promise<Trace> {
  const turn = await host
    .observe({ chatId: trace.chatId, userId: trace.userId })
    .status(trace.streamId);
  return { ...trace, status: turn?.status ?? trace.status };
}
