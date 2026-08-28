import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type {
  AgentPluginDefinition,
  ConversationId,
} from '@deepagents/experimental/zukhruf';
import {
  type HttpEnv,
  type HttpRuntime,
  projectHttp,
} from '@deepagents/experimental/zukhruf/http';

import type {
  AgentTraceReader,
  AgentTraceSummary,
} from './file-trace-adapter.ts';
import type { FileTelemetryInstance } from './index.ts';

const TRACES_PATH = '/traces';
const NO_STORE = { 'cache-control': 'no-store' } as const;

export function tracesHttp(
  definition: AgentPluginDefinition<FileTelemetryInstance>,
) {
  return projectHttp(definition, (plugin, runtime) => ({
    capabilities: { traces: { path: TRACES_PATH } },
    authenticatedRoutes: traceRoutes(plugin.traces, runtime),
  }));
}

function traceRoutes(reader: AgentTraceReader, runtime: HttpRuntime) {
  const app = new Hono<HttpEnv>();
  app.get(`${TRACES_PATH}/:chatId`, async (context) => {
    const conversation = await requireConversation(runtime, {
      chatId: context.req.param('chatId'),
      userId: context.get('userId'),
    });
    return context.json(
      await Promise.all(
        (await reader.list(conversation)).map((trace) =>
          withDurableStatus(runtime, trace),
        ),
      ),
      200,
      NO_STORE,
    );
  });
  app.get(`${TRACES_PATH}/:chatId/:traceId`, async (context) => {
    const conversation = await requireConversation(runtime, {
      chatId: context.req.param('chatId'),
      userId: context.get('userId'),
    });
    const traceId = context.req.param('traceId');
    const trace = await reader.get(conversation, traceId);
    if (!trace) {
      throw new HTTPException(404, {
        message: 'Trace not found',
        cause: {
          code: 'traces/trace-not-found',
          detail: `Trace ${traceId} does not exist in conversation ${conversation.chatId}`,
        },
      });
    }
    return context.json(await withDurableStatus(runtime, trace), 200, NO_STORE);
  });
  return app;
}

async function requireConversation(
  runtime: Pick<HttpRuntime, 'listHistory'>,
  conversation: ConversationId,
): Promise<ConversationId> {
  const owned = (await runtime.listHistory()).some(
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
  runtime: Pick<HttpRuntime, 'observe'>,
  trace: Trace,
): Promise<Trace> {
  const turn = await runtime
    .observe({ chatId: trace.chatId, userId: trace.userId })
    .status(trace.streamId);
  return { ...trace, status: turn?.status ?? trace.status };
}
