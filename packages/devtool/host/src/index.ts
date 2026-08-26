import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { fileURLToPath } from 'node:url';

import {
  type TraceSource,
  configureTraceTelemetry,
  discoverTraceSource,
  mountTraceRoutes,
} from '@deepagents/devtool-traces';
import type {
  AgentDeclaration,
  AgentPluginDefinition,
  AgentPluginHost,
  AgentPluginInstance,
  AgentPluginToolContext,
} from '@deepagents/experimental/zukhruf';
import {
  ZUKHRUF_HISTORY_ROUTE_PATH,
  ZUKHRUF_INFO_ROUTE_PATH,
  ZUKHRUF_ROUTE_PREFIX,
  zukhrufDiscovery,
} from '@deepagents/experimental/zukhruf';

export interface DevtoolOptions {
  hostname?: '127.0.0.1' | '::1';
  port?: number;
}

export type Devtool = AgentPluginInstance & { readonly url?: URL };
type RunningDevtool = AsyncDisposable & { readonly url: URL };

const ui = fileURLToPath(new URL('./ui/', import.meta.url));
const uiShell = serveStatic({ root: ui, path: 'index.html' });

function createApp(host: AgentPluginHost, traces: TraceSource | undefined) {
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
  mountTraceRoutes(app, traces, host);
  return app
    .use('/assets/*', serveStatic({ root: ui }))
    .on(
      'GET',
      ['/assets/*', '/api/*', `${ZUKHRUF_ROUTE_PREFIX}/*`, '/health/*'],
      (context) => context.notFound(),
    )
    .get('*', uiShell);
}

export function devtool(
  options: DevtoolOptions = {},
): AgentPluginDefinition<Devtool> {
  const resolved = resolveOptions(options);
  return {
    name: 'devtool',
    create: () => new DevtoolPlugin(resolved),
  };
}

class DevtoolPlugin implements Devtool {
  readonly #hostname: NonNullable<DevtoolOptions['hostname']>;
  readonly #port: number;
  #host?: AgentPluginHost;
  #traces?: TraceSource;
  #url?: URL;

  constructor({ hostname, port }: Required<DevtoolOptions>) {
    this.#hostname = hostname;
    this.#port = port;
  }

  get url(): URL | undefined {
    return this.#url;
  }

  configure(root: AgentDeclaration): AgentDeclaration {
    this.#traces = discoverTraceSource(root);
    return root;
  }

  configureTelemetry(
    context: AgentPluginToolContext,
    telemetry: AgentDeclaration['telemetry'],
  ): AgentDeclaration['telemetry'] {
    return configureTraceTelemetry(this.#traces, context, telemetry);
  }

  initialize(host: AgentPluginHost): Promise<void> {
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
