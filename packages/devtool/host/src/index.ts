import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { fileURLToPath } from 'node:url';

export const DEVTOOL_ROUTE_PREFIX = '/devtool';

const ui = fileURLToPath(new URL('./ui/', import.meta.url));

/**
 * Static DevTool UI. Mount with `app.route(DEVTOOL_ROUTE_PREFIX, devtool())`
 * on the same origin that mounts `zukhruf(runtime)`; the browser discovers
 * every runtime capability through `GET /zukhruf/v1/info`.
 */
export function devtool() {
  return new Hono()
    .use(
      '/assets/*',
      serveStatic({
        root: ui,
        rewriteRequestPath: (path) => path.slice(DEVTOOL_ROUTE_PREFIX.length),
      }),
    )
    .get('/assets/*', (context) => context.notFound())
    .get('*', serveStatic({ root: ui, path: 'index.html' }));
}
