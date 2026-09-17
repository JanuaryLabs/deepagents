import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { styleText } from 'node:util';

import { devtool } from '@deepagents/devtool';
import { tracesHttp } from '@deepagents/devtool/traces';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';
import { uploadsHttp } from '@deepagents/experimental/zukhruf/uploads/http';

import { imageUploads, traceTelemetry } from './agent.ts';
import runtime from './run.ts';
import stack from './stack.ts';

await using host = await runtime.initialize(stack);
await using worker = await host.work();

const app = new Hono<HttpEnv>();
const devtoolPath = '/devtool';
app.use('/zukhruf/v1/*', (context, next) => {
  context.set('userId', 'demo');
  return next();
});
app.route(
  '/zukhruf/v1',
  http(
    host,
    uploadsHttp(imageUploads, { maxBytes: 20 * 1024 * 1024 }),
    tracesHttp(traceTelemetry),
  ),
);
app.route(devtoolPath, devtool());

const started = Promise.withResolvers<URL>();
await using server = serve(
  { fetch: app.fetch, hostname: '127.0.0.1', port: 4317 },
  ({ port }) =>
    started.resolve(new URL(devtoolPath, `http://127.0.0.1:${port}`)),
);
console.log(styleText('bold', `Open ${(await started.promise).href}`));
console.log(styleText('dim', 'Press Ctrl+C to stop.'));

const stopped = Promise.withResolvers<void>();
process.once('SIGINT', () => stopped.resolve());
process.once('SIGTERM', () => stopped.resolve());
await stopped.promise;
