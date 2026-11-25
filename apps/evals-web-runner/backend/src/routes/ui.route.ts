import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { lstat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { AppBindings } from '../store.ts';

export default function (router: Hono<AppBindings>) {
  const dir = join(
    relative(process.cwd(), import.meta.dirname),
    '../',
    '../',
    '../',
    'frontend',
    'dist',
  );

  console.log(process.env.BASE_PATH);
  // Only serve actual static assets (JS, CSS, images, etc.)
  // Do NOT use '*' here - that would serve index.html before the handler below can inject the base href
  router.use('/assets/*', serveStatic({ root: dir }));
  router.get('*', async (c) => {
    const exists = await lstat(`${dir}/index.html`).then(
      () => true,
      (error: unknown) => {
        // Not built yet; any other failure is the route's error.
        if (
          Error.isError(error) &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return false;
        }
        throw error;
      },
    );
    if (!exists) {
      console.error(
        `Build the frontend app first. run "nx run frontend:build"`,
      );
      return c.json({ error: 'Build the frontend app first' }, 404);
    }

    const html = await readFile(`${dir}/index.html`, 'utf-8');

    return c.html(html);
  });
}
