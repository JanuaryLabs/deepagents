import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { fileURLToPath } from 'node:url';

import type {
  AgentDeclaration,
  AgentHistoryItem,
  AgentPluginHost,
  AgentRuntimePlugin,
  ConversationId,
} from '@deepagents/experimental/zukhruf';
import {
  ZUKHRUF_HISTORY_ROUTE_PATH,
  ZUKHRUF_INFO_ROUTE_PATH,
  zukhrufDiscovery,
} from '@deepagents/experimental/zukhruf';

import {
  type AgentTraceSummary,
  FileTraceAdapter,
} from './file-trace-adapter.ts';

export interface DevtoolOptions {
  hostname?: '127.0.0.1' | '::1';
  port?: number;
}

export type Devtool = AgentRuntimePlugin & { readonly url?: URL };
type RunningDevtool = AsyncDisposable & { readonly url: URL };

const ui = fileURLToPath(new URL('./ui/', import.meta.url));
const TRACE_LIST_ROUTE = '/api/history/:chatId/traces' as const;
const TRACE_ROUTE = '/api/history/:chatId/traces/:traceId' as const;

function createApp(
  host: AgentPluginHost,
  traces:
    { readonly path: string; readonly adapter: FileTraceAdapter } | undefined,
) {
  const app = new Hono();
  app.get('/health', (context) => context.json({ ok: true }));
  app.get(ZUKHRUF_INFO_ROUTE_PATH, (context) =>
    context.json({
      ...zukhrufDiscovery(host),
      ...(traces === undefined ? {} : { traces: { path: traces.path } }),
    }),
  );
  app.get(ZUKHRUF_HISTORY_ROUTE_PATH, async (context) =>
    context.json(await host.listHistory()),
  );
  mountTraceRoutes(
    app,
    traces?.adapter,
    async (_request, chatId, userId) =>
      requestedConversation(await host.listHistory(), chatId, userId),
    (trace) => withDurableStatus(host, trace),
  );
  return app
    .get('/', serveStatic({ root: ui, path: 'index.html' }))
    .use('/assets/*', serveStatic({ root: ui }));
}

export function devtool(options: DevtoolOptions = {}): Devtool {
  return new DevtoolPlugin(options);
}

class DevtoolPlugin implements Devtool {
  readonly name = 'devtool';
  readonly #hostname: NonNullable<DevtoolOptions['hostname']>;
  readonly #port: number;
  #host?: AgentPluginHost;
  #traces?: { readonly path: string; readonly adapter: FileTraceAdapter };
  #url?: URL;

  constructor(options: DevtoolOptions) {
    const { hostname, port } = resolveOptions(options);
    this.#hostname = hostname;
    this.#port = port;
  }

  get url(): URL | undefined {
    return this.#url;
  }

  configure(root: AgentDeclaration): AgentDeclaration {
    this.#traces = undefined;
    const paths = new Set<string>();
    const collect = (declaration: AgentDeclaration): void => {
      for (const path of tracePaths(declaration)) paths.add(path);
      for (const subagent of declaration.subagents ?? []) collect(subagent);
    };
    collect(root);
    if (paths.size !== 1) return root;

    const [path] = paths;
    const source = new URL(path);
    if (source.protocol !== 'file:') return root;
    this.#traces = { path, adapter: new FileTraceAdapter(source) };

    const includeTraceContext = (
      declaration: AgentDeclaration,
    ): AgentDeclaration => ({
      ...declaration,
      ...(tracePaths(declaration).includes(path)
        ? {
            telemetry: {
              ...declaration.telemetry,
              includeRuntimeContext: {
                ...declaration.telemetry?.includeRuntimeContext,
                zukhruf: true,
              },
            },
          }
        : {}),
      ...(declaration.subagents === undefined
        ? {}
        : { subagents: declaration.subagents.map(includeTraceContext) }),
    });
    return includeTraceContext(root);
  }

  initialize(host: AgentPluginHost): Promise<void> {
    if (this.#host && this.#host !== host) {
      throw new Error(
        'devtool plugin cannot be shared by AgentRuntime instances',
      );
    }
    this.#host = host;
    return Promise.resolve();
  }

  async work(host: AgentPluginHost): Promise<AsyncDisposable> {
    if (this.#host !== host) {
      throw new Error('devtool plugin must be initialized before work starts');
    }
    if (this.#url) throw new Error('devtool plugin is already running');

    const running = await startDevtool(createApp(host, this.#traces), {
      hostname: this.#hostname,
      port: this.#port,
    });
    this.#url = running.url;

    return {
      [Symbol.asyncDispose]: async () => {
        await running[Symbol.asyncDispose]();
        this.#url = undefined;
      },
    };
  }
}

function mountTraceRoutes(
  app: Hono,
  traces: FileTraceAdapter | undefined,
  findConversation: (
    request: Request,
    chatId: string,
    userId: string | undefined,
  ) => Promise<ConversationId | undefined>,
  projectStatus: <Trace extends AgentTraceSummary>(
    trace: Trace,
  ) => Promise<Trace> = (trace) => Promise.resolve(trace),
): void {
  if (!traces) return;
  app.get(TRACE_LIST_ROUTE, async (context) => {
    const conversation = await findConversation(
      context.req.raw,
      context.req.param('chatId'),
      context.req.query('userId'),
    );
    if (!conversation) return context.json({ error: 'Not found' }, 404);
    return context.json(
      await Promise.all(
        (await traces.list(conversation)).map((trace) => projectStatus(trace)),
      ),
    );
  });
  app.get(TRACE_ROUTE, async (context) => {
    const conversation = await findConversation(
      context.req.raw,
      context.req.param('chatId'),
      context.req.query('userId'),
    );
    if (!conversation) return context.json({ error: 'Not found' }, 404);
    const trace = await traces.get(conversation, context.req.param('traceId'));
    if (!trace) return context.json({ error: 'Not found' }, 404);
    return context.json(await projectStatus(trace));
  });
}

function requestedConversation(
  history: readonly AgentHistoryItem[],
  chatId: string,
  userId: string | undefined,
): ConversationId | undefined {
  if (userId === undefined) return undefined;
  return history.find(
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
    const path = (integration as { traces?: { path?: unknown } }).traces?.path;
    return typeof path === 'string' && URL.canParse(path) ? [path] : [];
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

function resolveOptions({
  hostname = '127.0.0.1',
  port = 4317,
}: DevtoolOptions): Required<DevtoolOptions> {
  if (hostname !== '127.0.0.1' && hostname !== '::1') {
    throw new TypeError('devtool hostname must be a loopback address');
  }
  return { hostname, port };
}

async function startDevtool(
  app: Pick<Hono, 'fetch'>,
  options: DevtoolOptions,
): Promise<RunningDevtool> {
  const { hostname, port } = resolveOptions(options);
  const started = Promise.withResolvers<URL>();
  const server = serve(
    { fetch: app.fetch, hostname, port },
    ({ address, port: boundPort }) => {
      const boundHostname = address.includes(':') ? `[${address}]` : address;
      started.resolve(new URL(`http://${boundHostname}:${boundPort}/`));
    },
  );
  const rejectStartup = (error: Error) => started.reject(error);
  server.once('error', rejectStartup);

  try {
    return {
      url: await started.promise,
      [Symbol.asyncDispose]: () => server[Symbol.asyncDispose](),
    };
  } catch (error) {
    if (server.listening) await server[Symbol.asyncDispose]();
    throw error;
  } finally {
    server.off('error', rejectStartup);
  }
}
