import { Hono } from 'hono';

import type {
  AgentDeclaration,
  AgentPluginHost,
  AgentPluginToolContext,
} from '@deepagents/experimental/zukhruf';

import {
  type AgentTraceSummary,
  FileTraceAdapter,
} from './file-trace-adapter.ts';

export * from './file-trace-adapter.ts';

export interface TraceSource {
  readonly path: string;
  readonly adapter: FileTraceAdapter;
}

type TelemetryIntegration = Exclude<
  NonNullable<NonNullable<AgentDeclaration['telemetry']>['integrations']>,
  readonly unknown[]
>;

const TRACE_LIST_ROUTE = '/api/history/:chatId/traces' as const;
const TRACE_ROUTE = '/api/history/:chatId/traces/:traceId' as const;

export function discoverTraceSource(
  root: AgentDeclaration,
): TraceSource | undefined {
  const paths = new Set<string>();
  const collect = (declaration: AgentDeclaration): void => {
    for (const path of tracePaths(declaration)) paths.add(path);
    for (const subagent of declaration.subagents ?? []) collect(subagent);
  };
  collect(root);
  if (paths.size !== 1) return undefined;

  const [path] = paths;
  const source = new URL(path);
  if (source.protocol !== 'file:') return undefined;
  return { path, adapter: new FileTraceAdapter(source) };
}

export function configureTraceTelemetry(
  source: TraceSource | undefined,
  context: AgentPluginToolContext,
  telemetry: AgentDeclaration['telemetry'],
): AgentDeclaration['telemetry'] {
  const path = source?.path;
  const integrations = telemetry?.integrations;
  if (path === undefined || integrations === undefined) return telemetry;

  const decorate = (integration: TelemetryIntegration): TelemetryIntegration =>
    tracePath(integration) === path
      ? {
          ...integration,
          onStart: (event) =>
            integration.onStart?.call(integration, {
              ...event,
              zukhruf: context,
            }),
        }
      : integration;
  return {
    ...telemetry,
    integrations: Array.isArray(integrations)
      ? integrations.map(decorate)
      : decorate(integrations),
  };
}

export function mountTraceRoutes(
  app: Hono,
  source: TraceSource | undefined,
  host: AgentPluginHost,
): void {
  if (!source) return;
  app.get(TRACE_LIST_ROUTE, async (context) => {
    const conversation = await requestedConversation(
      host,
      context.req.param('chatId'),
      context.req.query('userId'),
    );
    if (!conversation) return context.json({ error: 'Not found' }, 404);
    return context.json(
      await Promise.all(
        (await source.adapter.list(conversation)).map((trace) =>
          withDurableStatus(host, trace),
        ),
      ),
    );
  });
  app.get(TRACE_ROUTE, async (context) => {
    const conversation = await requestedConversation(
      host,
      context.req.param('chatId'),
      context.req.query('userId'),
    );
    if (!conversation) return context.json({ error: 'Not found' }, 404);
    const trace = await source.adapter.get(
      conversation,
      context.req.param('traceId'),
    );
    if (!trace) return context.json({ error: 'Not found' }, 404);
    return context.json(await withDurableStatus(host, trace));
  });
}

async function requestedConversation(
  host: AgentPluginHost,
  chatId: string,
  userId: string | undefined,
) {
  if (userId === undefined) return undefined;
  return (await host.listHistory()).find(
    (item) => item.chatId === chatId && item.userId === userId,
  );
}

function tracePaths(declaration: AgentDeclaration): string[] {
  const integrations = declaration.telemetry?.integrations;
  return (
    integrations === undefined
      ? []
      : Array.isArray(integrations)
        ? integrations
        : [integrations]
  ).flatMap((integration) => {
    const path = tracePath(integration);
    return path === undefined ? [] : [path];
  });
}

function tracePath(integration: TelemetryIntegration): string | undefined {
  const path = (integration as { traces?: { path?: unknown } }).traces?.path;
  return typeof path === 'string' && URL.canParse(path) ? path : undefined;
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
