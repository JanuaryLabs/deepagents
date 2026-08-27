import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { type Context, Hono } from 'hono';
import { proxy } from 'hono/proxy';
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
  ZUKHRUF_CREATE_SESSION_ROUTE_PATH,
  ZUKHRUF_HISTORY_ROUTE_PATH,
  ZUKHRUF_INFO_ROUTE_PATH,
  ZUKHRUF_ROUTE_PREFIX,
  zukhrufDiscovery,
} from '@deepagents/experimental/zukhruf';

export interface DevtoolOptions {
  hostname?: '127.0.0.1' | '::1';
  port?: number;
  runtime?: {
    url: string | URL;
    headers?: RuntimeHeaders | (() => RuntimeHeaders | Promise<RuntimeHeaders>);
  };
}

export type Devtool = AgentPluginInstance & { readonly url?: URL };
type RunningDevtool = AsyncDisposable & { readonly url: URL };
type RuntimeHeaders = NonNullable<ConstructorParameters<typeof Headers>[0]>;

const ui = fileURLToPath(new URL('./ui/', import.meta.url));
const uiShell = serveStatic({ root: ui, path: 'index.html' });

type ResolvedDevtoolOptions = Required<
  Pick<DevtoolOptions, 'hostname' | 'port'>
> & {
  runtime?: NonNullable<DevtoolOptions['runtime']> & { url: URL };
};

function createApp(
  host: AgentPluginHost,
  traces: TraceSource | undefined,
  runtime: ResolvedDevtoolOptions['runtime'],
) {
  const app = new Hono();
  app.get('/health', (context) => context.json({ ok: true }));
  app.get(ZUKHRUF_INFO_ROUTE_PATH, (context) => {
    const discovery = zukhrufDiscovery(host);
    return context.json({
      ...discovery,
      capabilities: {
        ...discovery.capabilities,
        ...(runtime
          ? { chat: { href: ZUKHRUF_CREATE_SESSION_ROUTE_PATH } }
          : {}),
      },
      ...(traces === undefined ? {} : { traces: { path: traces.path } }),
    });
  });
  app.get(ZUKHRUF_HISTORY_ROUTE_PATH, async (context) =>
    context.json(await host.listHistory()),
  );
  if (runtime) {
    const forward = (context: Context) =>
      forwardRuntimeRequest(context, runtime);
    app.all(ZUKHRUF_CREATE_SESSION_ROUTE_PATH, forward);
    app.all(`${ZUKHRUF_CREATE_SESSION_ROUTE_PATH}/*`, forward);
  }
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
  readonly #runtime?: ResolvedDevtoolOptions['runtime'];
  #host?: AgentPluginHost;
  #traces?: TraceSource;
  #url?: URL;

  constructor({ hostname, port, runtime }: ResolvedDevtoolOptions) {
    this.#hostname = hostname;
    this.#port = port;
    this.#runtime = runtime;
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

    const running = await startDevtool(
      createApp(host, this.#traces, this.#runtime),
      {
        hostname: this.#hostname,
        port: this.#port,
      },
    );
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
  runtime,
}: DevtoolOptions): ResolvedDevtoolOptions {
  if (hostname !== '127.0.0.1' && hostname !== '::1') {
    throw new TypeError('devtool hostname must be a loopback address');
  }
  if (!runtime) return { hostname, port };
  const url = new URL(runtime.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('devtool runtime URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new TypeError('devtool runtime URL must not contain credentials');
  }
  return { hostname, port, runtime: { ...runtime, url } };
}

async function forwardRuntimeRequest(
  context: Context,
  runtime: NonNullable<ResolvedDevtoolOptions['runtime']>,
) {
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'idempotency-key']) {
    const value = context.req.header(name);
    if (value) headers.set(name, value);
  }
  const configuredHeaders =
    typeof runtime.headers === 'function'
      ? await runtime.headers()
      : runtime.headers;
  for (const [name, value] of new Headers(configuredHeaders)) {
    headers.set(name, value);
  }
  const response = await proxy(new URL(context.req.path, runtime.url), {
    raw: context.req.raw,
    headers,
  });
  response.headers.delete('set-cookie');
  return response;
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
