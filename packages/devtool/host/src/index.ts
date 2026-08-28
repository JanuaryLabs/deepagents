import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { basePath } from 'hono/route';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ui = fileURLToPath(new URL('./ui/', import.meta.url));
const shell = await readFile(
  new URL('./ui/index.html', import.meta.url),
  'utf8',
);

/**
 * Static DevTool UI. Mount with `app.route(path, devtool())` on the same origin
 * that mounts `http(runtime)`; the browser discovers every runtime capability
 * through `GET /zukhruf/v1/info`.
 */
export function devtool() {
  return new Hono()
    .use(
      '/assets/*',
      serveStatic({
        root: ui,
        rewriteRequestPath: (path, context) =>
          path.slice(basePath(context).replace(/\/$/, '').length),
      }),
    )
    .get('/assets/*', (context) => context.notFound())
    .get('*', async (context) => {
      const mount = basePath(context).replace(/\/$/, '');
      const base = await html`<base href="${mount}/" />`;
      return context.html(shell.replace('<head>', `<head>${base}`));
    });
}
