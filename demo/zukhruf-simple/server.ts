import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { DEVTOOL_ROUTE_PREFIX, devtool } from '@deepagents/devtool';
import {
  type AgentRuntime,
  ZUKHRUF_ROUTE_PREFIX,
  zukhruf,
} from '@deepagents/experimental/zukhruf';

/**
 * One host server: the authenticated Zukhruf protocol at `/zukhruf/v1` and
 * the DevTool UI at `/devtool` on the same origin.
 */
export function serveDevtool(runtime: AgentRuntime) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use(`${ZUKHRUF_ROUTE_PREFIX}/*`, async (context, next) => {
    context.set('userId', 'demo');
    await next();
  });
  app.route(ZUKHRUF_ROUTE_PREFIX, zukhruf(runtime));
  app.route(DEVTOOL_ROUTE_PREFIX, devtool());

  const started = Promise.withResolvers<URL>();
  const server = serve(
    { fetch: app.fetch, hostname: '127.0.0.1', port: 4317 },
    ({ port }) =>
      started.resolve(
        new URL(DEVTOOL_ROUTE_PREFIX, `http://127.0.0.1:${port}`),
      ),
  );
  return { server, url: started.promise };
}
