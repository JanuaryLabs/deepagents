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
 * Static DevTool UI. Mount with `app.route(path, devtool({ protocolPath }))` on
 * the same origin that mounts `http(runtime)` at `protocolPath`.
 */
export function devtool({
  protocolPath = '/zukhruf/v1',
}: { protocolPath?: string } = {}) {
  const parsed = new URL(protocolPath, 'http://localhost');
  if (
    parsed.origin !== 'http://localhost' ||
    parsed.pathname !== protocolPath
  ) {
    throw new TypeError(
      'devtool: protocolPath must be a same-origin absolute path',
    );
  }
  const infoPath = `${protocolPath.replace(/\/+$/, '')}/info`;
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
      const configuration = await html`<meta
        name="deepagents-zukhruf-info"
        content="${infoPath}"
      />`;
      return context.html(
        shell.replace('<head>', `<head>${base}${configuration}`),
      );
    });
}
